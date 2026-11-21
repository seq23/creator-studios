// A fake S3 endpoint for tests (worker/services/s3files.ts): tests/unit/s3-files.test.ts, tests/unit/host-storage.test.ts.

/** A tiny S3 server over a Map: the request shapes R2's S3 endpoint answers, including its failure shapes. */
export function fakeS3(opts: { failPut?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; type: string | null; etag: string }>();
  const uploads = new Map<string, { key: string; type: string | null; parts: Map<number, Uint8Array> }>();
  const seen: Request[] = [];
  let n = 0;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    seen.push(req);
    if (!req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const u = new URL(req.url);
    const [, bucket, ...rest] = u.pathname.split("/");
    if (bucket !== "her-bucket") return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    const key = rest.map(decodeURIComponent).join("/");
    const body = req.method === "PUT" || req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : null;
    const etagOf = () => `"e${++n}"`;
    if (!key && req.method === "GET") {
      const keys = [...objects.keys()].filter((k) => k.startsWith(u.searchParams.get("prefix") ?? "")).sort();
      const max = Number(u.searchParams.get("max-keys") ?? 1000);
      const from = Number(u.searchParams.get("continuation-token") ?? 0);
      const page = keys.slice(from, from + max);
      const more = from + max < keys.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k)!.bytes.length}</Size><ETag>&quot;${objects.get(k)!.etag.replace(/"/g, "")}&quot;</ETag><LastModified>2026-11-20T00:00:00.000Z</LastModified></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + max}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return new Response(xml);
    }
    if (u.searchParams.has("uploads")) {
      const id = `up${++n}`;
      uploads.set(id, { key, type: req.headers.get("content-type"), parts: new Map() });
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    const uploadId = u.searchParams.get("uploadId");
    if (uploadId) {
      const up = uploads.get(uploadId);
      if (!up) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      if (req.method === "PUT") {
        up.parts.set(Number(u.searchParams.get("partNumber")), body!);
        return new Response(null, { headers: { etag: `"p${u.searchParams.get("partNumber")}"` } });
      }
      if (req.method === "DELETE") {
        uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      const wanted = [...new TextDecoder().decode(body!).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      if (wanted.some((p) => !up.parts.has(p))) return new Response("<Error><Code>InvalidPart</Code></Error>", { status: 200 });
      const all = wanted.map((p) => up.parts.get(p)!);
      const bytes = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
      let o = 0;
      for (const b of all) bytes.set(b, (o += b.length) - b.length);
      objects.set(up.key, { bytes, type: up.type, etag: etagOf() });
      uploads.delete(uploadId);
      return new Response("<CompleteMultipartUploadResult/>");
    }
    const obj = objects.get(key);
    if (req.method === "PUT") {
      if (opts.failPut) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      objects.set(key, { bytes: body!, type: req.headers.get("content-type"), etag: etagOf() });
      return new Response(null, { headers: { etag: objects.get(key)!.etag } });
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!obj) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const h = { etag: obj.etag, "content-type": obj.type ?? "application/octet-stream", "last-modified": "Thu, 20 Nov 2026 00:00:00 GMT" };
    const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Math.min(Number(range[2]), obj.bytes.length - 1) : obj.bytes.length - 1;
      return new Response(req.method === "HEAD" ? null : obj.bytes.slice(from, to + 1), { status: 206, headers: { ...h, "content-length": String(to - from + 1), "content-range": `bytes ${from}-${to}/${obj.bytes.length}` } });
    }
    return new Response(req.method === "HEAD" ? null : obj.bytes, { headers: { ...h, "content-length": String(obj.bytes.length) } });
  };
  return { fetcher: fetcher as typeof fetch, objects, uploads, seen };
}

