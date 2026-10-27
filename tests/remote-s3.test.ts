import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadRemoteTarget, saveRemoteTarget, S3RemoteStore, signS3Request, validateRemoteTarget, type RemoteTarget } from "../src/storage/remote/s3.js";

describe("S3 compatible remote transport", () => {
  let root: string; let server: Server; let target: RemoteTarget; let store: S3RemoteStore;
  let objects: Map<string, { bytes: Buffer; checksum: string }>;
  let mode: "normal" | "lost-response" | "tamper" | "redirect" | "unauthorized";
  let environment: Record<string, string | undefined>; let requests: Array<{ method: string; authorization: string }>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-s3-test-")); objects = new Map(); mode = "normal"; requests = [];
    environment = Object.fromEntries(["PACK_TEST_ACCESS", "PACK_TEST_SECRET"].map(key => [key, process.env[key]]));
    process.env.PACK_TEST_ACCESS = "fixture-access-id"; process.env.PACK_TEST_SECRET = "fixture-secret-only";
    server = createServer(async (request, response) => {
      requests.push({ method: request.method!, authorization: request.headers.authorization ?? "" });
      if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/other" }).end(); return; }
      if (mode === "unauthorized") { response.writeHead(403).end("credential-like response must not reach errors"); return; }
      const key = request.url!;
      if (request.method === "PUT") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end(); return; }
        if (objects.has(key)) { response.writeHead(412).end(); return; }
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== request.headers["x-amz-content-sha256"]) { response.writeHead(400).end(); return; }
        objects.set(key, { bytes, checksum });
        if (mode === "lost-response") { request.socket.destroy(); return; }
        response.writeHead(200).end(); return;
      }
      const object = objects.get(key);
      if (!object) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-length": object.bytes.length, "x-amz-meta-sha256": mode === "tamper" ? "0".repeat(64) : object.checksum });
      response.end(request.method === "HEAD" ? undefined : object.bytes);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    target = validateRemoteTarget({ endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", bucket: "test-bucket",
      accessKeyEnv: "PACK_TEST_ACCESS", secretKeyEnv: "PACK_TEST_SECRET", passphraseEnv: "PACK_TEST_PASSWORD", allowLoopbackHttp: true });
    store = new S3RemoteStore(target);
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });

  it("streams immutable objects, verifies download and preserves existing destinations", async () => {
    const source = join(root, "source"); const destination = join(root, "download");
    await writeFile(source, Buffer.alloc(1024 * 1024, 73));
    const uploaded = await store.upload("prj_a/backup.pcmb", source, [root]);
    expect(uploaded.bytes).toBe(1024 * 1024);
    const downloaded = await store.download(uploaded.key, destination, [root]);
    expect(downloaded.sha256).toBe(uploaded.sha256); expect(await readFile(destination)).toEqual(await readFile(source));
    expect(requests.every(item => item.authorization.startsWith("AWS4-HMAC-SHA256 Credential=fixture-access-id/"))).toBe(true);
    expect((await store.upload(uploaded.key, source, [root])).recoveredResponse).toBe(true);
    await writeFile(source, "different");
    await expect(store.upload(uploaded.key, source, [root])).rejects.toMatchObject({ code: "REMOTE_OBJECT_CONFLICT" });
    await expect(store.download(uploaded.key, destination, [root])).rejects.toMatchObject({ code: "REMOTE_DOWNLOAD_FAILED" });
    expect((await readFile(destination)).length).toBe(1024 * 1024);
  });

  it("recovers a lost successful upload response by verifying HEAD", async () => {
    const path = join(root, "source"); await writeFile(path, "encrypted-fixture"); mode = "lost-response";
    expect(await store.upload("backup.pcmb", path, [root])).toMatchObject({ recoveredResponse: true });
    expect(requests.map(row => row.method)).toEqual(["PUT", "HEAD"]);
  });

  it("rejects tampering and removes incomplete downloads", async () => {
    const path = join(root, "source"); await writeFile(path, "encrypted-fixture");
    await store.upload("backup.pcmb", path, [root]); mode = "tamper";
    await expect(store.download("backup.pcmb", join(root, "download"), [root])).rejects.toMatchObject({ code: "REMOTE_CHECKSUM_MISMATCH" });
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("rejects insecure endpoints, traversal keys, redirects and missing credentials", async () => {
    expect(() => validateRemoteTarget({ ...target, endpoint: "http://example.com" })).toThrow();
    expect(() => validateRemoteTarget({ ...target, endpoint: "https://user:secret@example.com" })).toThrow();
    expect(() => validateRemoteTarget({ ...target, endpoint: "https://example.com/path" })).toThrow();
    await expect(store.download("../other", join(root, "download"), [root])).rejects.toMatchObject({ code: "INVALID_REMOTE_KEY" });
    mode = "redirect";
    await expect(store.download("backup.pcmb", join(root, "download"), [root])).rejects.toMatchObject({ code: "REMOTE_REQUEST_FAILED" });
    delete process.env.PACK_TEST_SECRET;
    await expect(store.download("backup.pcmb", join(root, "download"), [root])).rejects.toMatchObject({ code: "REMOTE_CREDENTIAL_UNAVAILABLE" });
  });

  it("stores environment references only and refuses silent target replacement", async () => {
    await saveRemoteTarget(root, "backup", target);
    const config = await readFile(join(root, "remote-targets", "backup.json"), "utf8");
    expect(config).toContain("PACK_TEST_SECRET"); expect(config).not.toContain("fixture-secret-only");
    expect(await loadRemoteTarget(root, "backup")).toEqual(target);
    await expect(saveRemoteTarget(root, "backup", target)).rejects.toMatchObject({ code: "REMOTE_TARGET_EXISTS" });
    await expect(loadRemoteTarget(root, "../backup")).rejects.toMatchObject({ code: "INVALID_REMOTE_NAME" });
  });

  it("signs a fixed canonical request consistently and separates different objects", () => {
    const time = new Date("2026-10-27T00:00:00Z"); const empty = createHash("sha256").update("").digest("hex");
    const config = { ...target, endpoint: "https://s3.example.com" };
    const signed = signS3Request(config, "GET", "backup.pcmb", empty, {}, time);
    expect(signed.headers["x-amz-date"]).toBe("20261027T000000Z");
    expect(signed.url.href).toBe("https://s3.example.com/test-bucket/project-context/backup.pcmb");
    expect(signed.headers.authorization).toContain("/20261027/us-east-1/s3/aws4_request");
    expect(signS3Request(config, "GET", "other.pcmb", empty, {}, time).headers.authorization).not.toBe(signed.headers.authorization);
  });
});
