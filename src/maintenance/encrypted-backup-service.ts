import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, link, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { SqliteDatabase } from "../storage/database.js";
import { ProjectContextError } from "../shared/errors.js";
import { authorizeExistingPath, authorizeOutputPath } from "../security/path-policy.js";

const MAGIC = Buffer.from("PCMBKUP1\n", "ascii");
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const MAX_HEADER_LENGTH = 16_384;

interface EncryptedHeader {
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  cost: number;
  blockSize: number;
  parallelization: number;
  createdAt: string;
  sourceName: string;
}

export function readPassphraseEnvironment(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new ProjectContextError("INVALID_PASSPHRASE_ENV", "Passphrase environment variable name is invalid.");
  }
  const value = process.env[name];
  if (!value) {
    throw new ProjectContextError("PASSPHRASE_ENV_NOT_SET", `Passphrase environment variable is not set: ${name}`);
  }
  return value;
}

export async function backupEncrypted(
  db: SqliteDatabase,
  destination: string,
  allowedOutputRoots: string[],
  passphrase: string,
): Promise<Record<string, unknown>> {
  const target = await authorizeOutputPath(destination, allowedOutputRoots);
  await ensureAbsent(target, "OUTPUT_EXISTS");
  await mkdir(dirname(target), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const plaintext = join(dirname(target), `.${basename(target)}.${nonce}.plain.db`);
  const temporary = join(dirname(target), `.${basename(target)}.${nonce}.tmp`);
  try {
    const backup = await db.backup(plaintext);
    await encryptFile(plaintext, temporary, passphrase);
    await link(temporary, target);
    await rm(temporary, { force: true });
    const output = await stat(target);
    return {
      destination: target,
      format: "project-context-encrypted-backup",
      version: 1,
      cipher: "aes-256-gcm",
      kdf: "scrypt",
      bytes: output.size,
      pages: backup.totalPages,
      completedAt: new Date().toISOString(),
    };
  } finally {
    await Promise.all([rm(plaintext, { force: true }), rm(temporary, { force: true })]);
  }
}

export async function decryptBackupToTemporary(
  source: string,
  allowedOutputRoots: string[],
  passphrase: string,
): Promise<{ source: string; temporary: string }> {
  const authorizedSource = await authorizeExistingPath(
    source,
    allowedOutputRoots,
    "BACKUP_SOURCE_NOT_AUTHORIZED",
    "Encrypted backup source",
  );
  const nonce = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const temporary = join(dirname(authorizedSource), `.${basename(authorizedSource)}.${nonce}.restore.db`);
  try {
    await decryptFile(authorizedSource, temporary, passphrase);
    return { source: authorizedSource, temporary };
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("ENCRYPTED_BACKUP_DECRYPT_FAILED", "Encrypted backup authentication or decryption failed.");
  }
}

async function encryptFile(source: string, destination: string, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header: EncryptedHeader = {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    createdAt: new Date().toISOString(),
    sourceName: basename(source).replace(/\.[^.]+\.plain\.db$/, ".db"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.length);
  const authenticatedHeader = Buffer.concat([MAGIC, length, headerBytes]);
  const key = await deriveKey(passphrase, salt, header);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(authenticatedHeader);
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  output.write(authenticatedHeader);
  await pipeline(createReadStream(source), cipher, output);
  await appendFile(destination, cipher.getAuthTag());
}

/** Encrypt an already-created portable snapshot using the existing authenticated envelope. */
export async function encryptPortableFile(
  source: string, destination: string, allowedOutputRoots: string[], passphrase: string,
): Promise<{ destination: string; bytes: number }> {
  const input = await authorizeExistingPath(source, allowedOutputRoots, "BACKUP_SOURCE_NOT_AUTHORIZED", "Portable snapshot");
  const target = await authorizeOutputPath(destination, allowedOutputRoots);
  await ensureAbsent(target, "OUTPUT_EXISTS");
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(16).toString("hex")}.tmp`);
  try {
    await encryptFile(input, temporary, passphrase);
    await link(temporary, target);
    return { destination: target, bytes: (await stat(target)).size };
  } finally { await rm(temporary, { force: true }); }
}

async function decryptFile(source: string, destination: string, passphrase: string): Promise<void> {
  const metadata = await readEncryptedHeader(source);
  const file = await stat(source);
  const ciphertextEnd = file.size - TAG_LENGTH - 1;
  if (ciphertextEnd < metadata.ciphertextStart) {
    throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup payload is truncated.");
  }
  const handle = await open(source, "r");
  let tag: Buffer;
  try {
    tag = Buffer.alloc(TAG_LENGTH);
    const result = await handle.read(tag, 0, TAG_LENGTH, file.size - TAG_LENGTH);
    if (result.bytesRead !== TAG_LENGTH) throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup tag is missing.");
  } finally {
    await handle.close();
  }
  const salt = Buffer.from(metadata.header.salt, "base64");
  const iv = Buffer.from(metadata.header.iv, "base64");
  if (salt.length !== 16 || iv.length !== 12) {
    throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup parameters are invalid.");
  }
  const key = await deriveKey(passphrase, salt, metadata.header);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(metadata.authenticatedHeader);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: metadata.ciphertextStart, end: ciphertextEnd }),
      decipher,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  } catch {
    throw new ProjectContextError("ENCRYPTED_BACKUP_DECRYPT_FAILED", "Encrypted backup authentication or decryption failed.");
  }
}

async function readEncryptedHeader(source: string): Promise<{
  header: EncryptedHeader;
  authenticatedHeader: Buffer;
  ciphertextStart: number;
}> {
  const prefix = Buffer.alloc(MAGIC.length + 4);
  const prefixHandle = await open(source, "r");
  try {
    const result = await prefixHandle.read(prefix, 0, prefix.length, 0);
    if (result.bytesRead !== prefix.length) {
      throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup header is truncated.");
    }
  } finally {
    await prefixHandle.close();
  }
  if (prefix.length !== MAGIC.length + 4 || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "File is not a Project Context encrypted backup.");
  }
  const headerLength = prefix.readUInt32BE(MAGIC.length);
  if (headerLength < 2 || headerLength > MAX_HEADER_LENGTH) {
    throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup header length is invalid.");
  }
  const authenticatedHeader = Buffer.alloc(MAGIC.length + 4 + headerLength);
  const handle = await open(source, "r");
  try {
    const result = await handle.read(authenticatedHeader, 0, authenticatedHeader.length, 0);
    if (result.bytesRead !== authenticatedHeader.length) {
      throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup header is truncated.");
    }
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(authenticatedHeader.subarray(MAGIC.length + 4).toString("utf8"));
  } catch {
    throw new ProjectContextError("INVALID_ENCRYPTED_BACKUP", "Encrypted backup header is invalid.");
  }
  if (!isEncryptedHeader(parsed)) {
    throw new ProjectContextError("UNSUPPORTED_ENCRYPTED_BACKUP", "Encrypted backup format or parameters are unsupported.");
  }
  return { header: parsed, authenticatedHeader, ciphertextStart: authenticatedHeader.length };
}

function isEncryptedHeader(value: unknown): value is EncryptedHeader {
  if (!value || typeof value !== "object") return false;
  const header = value as Record<string, unknown>;
  return header.version === 1
    && header.cipher === "aes-256-gcm"
    && header.kdf === "scrypt"
    && typeof header.salt === "string"
    && typeof header.iv === "string"
    && header.cost === SCRYPT_COST
    && header.blockSize === SCRYPT_BLOCK_SIZE
    && header.parallelization === SCRYPT_PARALLELIZATION
    && typeof header.createdAt === "string"
    && typeof header.sourceName === "string";
}

function deriveKey(passphrase: string, salt: Buffer, header: EncryptedHeader): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_LENGTH, {
      cost: header.cost,
      blockSize: header.blockSize,
      parallelization: header.parallelization,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function appendFile(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.write(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureAbsent(path: string, code: string): Promise<void> {
  try {
    await access(path);
    throw new ProjectContextError(code, `Destination already exists: ${path}`);
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
