import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod/v4";
import { ProjectContextError } from "../../shared/errors.js";
import { authorizeExistingPath, authorizeOutputPath } from "../../security/path-policy.js";
import { PACK_LIMITS } from "../remote-pack/schema.js";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const remoteTargetSchema = z.object({
  endpoint: z.string().url(), region: z.string().regex(/^[a-z0-9-]{1,64}$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  prefix: z.string().regex(/^[a-zA-Z0-9/_-]{0,200}$/).default("project-context"),
  accessKeyEnv: envName, secretKeyEnv: envName, sessionTokenEnv: envName.optional(),
  passphraseEnv: envName, allowLoopbackHttp: z.boolean().default(false),
}).strict();
export type RemoteTarget = z.infer<typeof remoteTargetSchema>;

export function validateRemoteTarget(input: unknown): RemoteTarget {
  const parsed = remoteTargetSchema.safeParse(input);
  if (!parsed.success) throw new ProjectContextError("INVALID_REMOTE_TARGET", "Invalid remote target configuration; supply environment variable names, never credential values.");
  const url = new URL(parsed.data.endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !(url.protocol === "https:" || (parsed.data.allowLoopbackHttp && url.protocol === "http:"
      && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new ProjectContextError("INVALID_REMOTE_ENDPOINT", "Use an HTTPS endpoint origin without credentials, path, query or fragment. Explicit loopback HTTP is available for local testing.");
  }
  return parsed.data;
}
function targetFile(storageRoot: string, name: string): string {
  if (!nameSchema.safeParse(name).success) throw new ProjectContextError("INVALID_REMOTE_NAME", "Remote name must contain 1–64 letters, digits, underscores or hyphens.");
  return join(storageRoot, "remote-targets", `${name}.json`);
}
export async function saveRemoteTarget(storageRoot: string, name: string, input: unknown) {
  const config = validateRemoteTarget(input); const path = targetFile(storageRoot, name);
  await mkdir(dirname(path), { recursive: true });
  // Explicit configuration is local; no network request or credential resolution here.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectContextError("REMOTE_TARGET_EXISTS", "A target with this name already exists; choose a new name to avoid changing existing backup destinations.");
    throw error;
  } finally { await rm(temporary, { force: true }); }
  return { name, ...config };
}
export async function loadRemoteTarget(storageRoot: string, name: string): Promise<RemoteTarget> {
  try {
    const path = targetFile(storageRoot, name);
    if ((await stat(path)).size > 16384) throw new Error("size");
    return validateRemoteTarget(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("REMOTE_TARGET_UNAVAILABLE", "Remote target is missing or invalid. Configure it locally first.");
  }
}
export async function listRemoteTargets(storageRoot: string) {
  let files: string[];
  try { files = await readdir(join(storageRoot, "remote-targets")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: Array<{ name: string; endpoint: string; bucket: string; prefix: string }> = [];
  for (const file of files.filter(file => file.endsWith(".json")).sort()) {
    const name = file.slice(0, -5);
    if (!nameSchema.safeParse(name).success) continue;
    const target = await loadRemoteTarget(storageRoot, name);
    result.push({ name, endpoint: target.endpoint, bucket: target.bucket, prefix: target.prefix });
  }
  return result;
}

function credential(name: string): string {
  const value = process.env[name];
  if (!value || /[\r\n]/.test(value)) throw new ProjectContextError("REMOTE_CREDENTIAL_UNAVAILABLE", "A required remote credential environment variable is missing or invalid.");
  return value;
}
function objectUrl(target: RemoteTarget, key: string): URL {
  if (key.length > 512 || !/^[a-zA-Z0-9/_.-]+$/.test(key)
    || key.split("/").some(part => !part || part === "." || part === "..")) {
    throw new ProjectContextError("INVALID_REMOTE_KEY", "Invalid remote object key.");
  }
  const prefix = target.prefix.split("/").filter(Boolean).join("/");
  const path = [target.bucket, ...(prefix ? [prefix] : []), key].join("/");
  return new URL("/" + path, target.endpoint);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

/** AWS Signature V4, path-style S3, no redirects or presigned URL credentials. */
export function signS3Request(target: RemoteTarget, method: string, key: string, payloadHash: string,
  extraHeaders: Record<string, string> = {}, now = new Date(), query?: Record<string, string>) {
  const url = query ? new URL("/" + target.bucket, target.endpoint) : objectUrl(target, key);
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  const canonicalQuery = query ? Object.entries(query).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => encode(key) + "=" + encode(value)).join("&") : "";
  url.search = canonicalQuery;
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8); const scope = `${day}/${target.region}/s3/aws4_request`;
  const headers: Record<string, string> = { ...extraHeaders, host: url.host, "x-amz-date": date, "x-amz-content-sha256": payloadHash };
  if (target.sessionTokenEnv) headers["x-amz-security-token"] = credential(target.sessionTokenEnv);
  const keys = Object.keys(headers).sort();
  const canonicalHeaders = keys.map(key => `${key}:${headers[key]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = keys.join(";");
  const canonical = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + credential(target.secretKeyEnv), day), target.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credential(target.accessKeyEnv)}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url, headers };
}

export class S3RemoteStore {
  readonly target: RemoteTarget;
  constructor(target: RemoteTarget) { this.target = validateRemoteTarget(target); }

  private async request(method: string, key: string, digest: string, headers: Record<string, string> = {}, file?: string, query?: Record<string, string>) {
    const signed = signS3Request(this.target, method, key, digest, headers, new Date(), query);
    const body = file ? createReadStream(file) : undefined;
    try {
      return await fetch(signed.url, { method, headers: signed.headers, redirect: "error",
        signal: AbortSignal.timeout(30_000), ...(body ? { body: body as unknown as BodyInit, duplex: "half" } : {}) });
    } catch {
      body?.destroy();
      throw new ProjectContextError("REMOTE_REQUEST_FAILED", "Remote request failed or timed out; local data remains available.");
    }
  }

  async list(prefix: string, continuationToken?: string) {
    objectUrl(this.target, prefix + "sentinel");
    const base = this.target.prefix.split("/").filter(Boolean).join("/");
    const fullPrefix = (base ? base + "/" : "") + prefix;
    const response = await this.request("GET", "", hash(""), {}, undefined, { "list-type": "2", "max-keys": "1000", prefix: fullPrefix,
      ...(continuationToken ? { "continuation-token": continuationToken } : {}) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new ProjectContextError("REMOTE_LIST_FAILED", `Remote listing failed (HTTP ${response.status}).`); }
    const parts: Uint8Array[] = []; let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ProjectContextError("REMOTE_LIST_LIMIT", "Remote listing exceeded size limit."); } parts.push(chunk.value); }
    } finally { reader.releaseLock(); }
    const xml = Buffer.concat(parts).toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !xml.includes("<ListBucketResult")) throw new ProjectContextError("REMOTE_LIST_INVALID", "Invalid object listing.");
    const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const keys = [...xml.matchAll(/<Key>([^<]*)<[/]Key>/g)].map(match => decode(match[1]!));
    if (keys.length > 1000 || keys.some(key => !key.startsWith(fullPrefix))) throw new ProjectContextError("REMOTE_LIST_INVALID", "Remote listing escaped the requested namespace.");
    const token = /<NextContinuationToken>([^<]*)<[/]NextContinuationToken>/.exec(xml)?.[1];
    const truncated = /<IsTruncated>\s*true\s*<[/]IsTruncated>/.test(xml);
    if (truncated && !token) throw new ProjectContextError("REMOTE_LIST_INVALID", "Truncated listing omitted its continuation token.");
    return { keys: keys.map(key => key.slice(base ? base.length + 1 : 0)), continuationToken: truncated ? decode(token!) : null };
  }

  async upload(key: string, source: string, allowedRoots: string[]) {
    const path = await authorizeExistingPath(source, allowedRoots, "REMOTE_SOURCE_NOT_AUTHORIZED", "Encrypted snapshot");
    const size = (await stat(path)).size;
    if (size > PACK_LIMITS.total + 32768) throw new ProjectContextError("REMOTE_SIZE_LIMIT", "Snapshot exceeds transfer limit.");
    const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk);
    const sha256 = digest.digest("hex");
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.request("PUT", key, sha256, { "content-type": "application/octet-stream",
          "content-length": String(size), "if-none-match": "*", "x-amz-meta-sha256": sha256 }, path);
        await response.body?.cancel();
        if (response.ok) return { key, sha256, bytes: size, recoveredResponse: false };
        if (response.status !== 412 && response.status !== 409 && response.status < 500 && response.status !== 429) {
          throw new ProjectContextError("REMOTE_HTTP_ERROR", `Remote upload failed (HTTP ${response.status}).`);
        }
      } catch (error) {
        if (error instanceof ProjectContextError && error.code === "REMOTE_HTTP_ERROR") throw error;
        lastError = error;
      }
      // A lost PUT response may still have published the immutable object. Verify before retry.
      const existing = await this.request("HEAD", key, hash("")).catch(() => null);
      if (existing?.ok) {
        if (existing.headers.get("x-amz-meta-sha256") === sha256 && existing.headers.get("content-length") === String(size)) {
          return { key, sha256, bytes: size, recoveredResponse: true };
        }
        throw new ProjectContextError("REMOTE_OBJECT_CONFLICT", "Remote object already exists with different content; it was not replaced.");
      }
    }
    if (lastError instanceof ProjectContextError) throw lastError;
    throw new ProjectContextError("REMOTE_UPLOAD_FAILED", "Remote upload could not be confirmed after retries.");
  }

  async download(key: string, destination: string, allowedRoots: string[]) {
    const target = await authorizeOutputPath(destination, allowedRoots);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const response = await this.request("GET", key, hash(""));
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ProjectContextError("REMOTE_HTTP_ERROR", `Remote download failed (HTTP ${response.status}).`);
      }
      const expected = response.headers.get("x-amz-meta-sha256");
      const length = Number(response.headers.get("content-length"));
      if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(length) || length < 1 || length > PACK_LIMITS.total + 32768) {
        await response.body.cancel();
        throw new ProjectContextError("REMOTE_INVALID_METADATA", "Remote object has missing or invalid size/checksum metadata.");
      }
      let bytes = 0; const digest = createHash("sha256");
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > length) { callback(new ProjectContextError("REMOTE_SIZE_LIMIT", "Remote object exceeds declared size.")); return; }
        digest.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limiter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (bytes !== length || digest.digest("hex") !== expected) throw new ProjectContextError("REMOTE_CHECKSUM_MISMATCH", "Downloaded snapshot checksum or size mismatch.");
      await link(temporary, target);
      return { key, destination: target, sha256: expected, bytes };
    } catch (error) {
      if (error instanceof ProjectContextError) throw error;
      throw new ProjectContextError("REMOTE_DOWNLOAD_FAILED", "Remote download failed; existing files are preserved.");
    } finally { await rm(temporary, { force: true }); }
  }
}
