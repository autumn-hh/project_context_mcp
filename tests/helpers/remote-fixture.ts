import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Isolated object store fixture that independently checks canonical AWS V4 signatures. */
export async function remoteFixture(accessKey: string, secret: string) {
  const objects = new Map<string, { bytes: Buffer; checksum: string }>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)[/]([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)$/.exec(request.headers.authorization ?? "");
    const payload = createHash("sha256").update(bytes).digest("hex");
    if (!auth || auth[1] !== accessKey || payload !== request.headers["x-amz-content-sha256"]) { response.writeHead(403).end(); return; }
    const signed = auth[3]!.split(";");
    const url = new URL(request.url!, "http://fixture");
    const canonical = [request.method, url.pathname, url.search.slice(1), signed.map(name => name + ":" + String(request.headers[name]).trim().replace(/\s+/g, " ") + "\n").join(""), auth[3], payload].join("\n");
    const scope = auth[2]!.split("/"); let signing: Buffer = Buffer.from("AWS4" + secret);
    for (const part of scope) signing = createHmac("sha256", signing).update(part).digest();
    const expected = createHmac("sha256", signing).update(["AWS4-HMAC-SHA256", request.headers["x-amz-date"], auth[2], createHash("sha256").update(canonical).digest("hex")].join("\n")).digest();
    const supplied = Buffer.from(auth[4]!, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) { response.writeHead(403).end(); return; }
    const key = request.url!;
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.pathname + "/" + url.searchParams.get("prefix");
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort().map(key => key.slice(url.pathname.length + 1));
      response.writeHead(200, { "content-type": "application/xml" }).end("<ListBucketResult><IsTruncated>false</IsTruncated>" + keys.map(key => "<Contents><Key>" + key + "</Key></Contents>").join("") + "</ListBucketResult>"); return;
    }
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end(); return; }
      if (objects.has(key)) { response.writeHead(412).end(); return; }
      objects.set(key, { bytes, checksum: payload }); response.writeHead(200).end(); return;
    }
    const item = objects.get(key);
    if (!item) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-length": item.bytes.length, "x-amz-meta-sha256": item.checksum });
    response.end(request.method === "HEAD" ? undefined : item.bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, objects,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
