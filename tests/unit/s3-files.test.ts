// A studio whose bucket is on another Cloudflare account (owner, 20 Nov 2026: Hadiyah's files moved
// to the second account) reaches it over the S3 API: worker/services/s3files.ts must behave like the
// R2 binding for everything the Worker does (put, get with a range, head, list, delete, multipart),
// and hydrate() must swap it in only when the registry says r2.s3.
import { describe, expect, it } from "vitest";
import { S3Files, filesFor, s3Config, signedDownload } from "@worker/services/s3files";
import { memoryR2 } from "./helpers/r2-memory";
import type { Env } from "@worker/env";

/** A tiny S3 server over a Map: the request shapes R2's S3 endpoint answers, including its failure shapes. */
function fakeS3(opts: { failPut?: boolean } = {}) {
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

const cfg = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "her-bucket", accessKeyId: "AKID", secretAccessKey: "SECRET" };
const bytes = (s: string) => new TextEncoder().encode(s);

/** The same steps against the R2 binding and against S3: the results must match. */
async function scenario(files: R2Bucket) {
  const out: unknown[] = [];
  await files.put("raw/d1/a b.mov", bytes("0123456789"), { httpMetadata: { contentType: "video/quicktime" } });
  await files.put("brain/doc", new Response("hello").body!, { httpMetadata: { contentType: "text/plain" } });
  const head = await files.head("raw/d1/a b.mov");
  out.push(["head", head?.size, head?.httpMetadata?.contentType]);
  out.push(["missing", await files.head("nope"), await files.get("nope")]);
  const ranged = await files.get("raw/d1/a b.mov", { range: new Headers({ range: "bytes=2-5" }) });
  out.push(["range", ranged?.size, ranged?.range, await new Response(ranged!.body).text()]);
  const whole = await files.get("brain/doc");
  const h = new Headers();
  whole!.writeHttpMetadata(h);
  out.push(["whole", await new Response(whole!.body).text(), h.get("content-type"), typeof whole!.httpEtag]);
  const mp = await files.createMultipartUpload("out/clip.mp4", { httpMetadata: { contentType: "video/mp4" } });
  const p1 = await files.resumeMultipartUpload("out/clip.mp4", mp.uploadId).uploadPart(1, new Response("abc").body!);
  const p2 = await files.resumeMultipartUpload("out/clip.mp4", mp.uploadId).uploadPart(2, bytes("def"));
  const done = await files.resumeMultipartUpload("out/clip.mp4", mp.uploadId).complete([p1, p2]);
  out.push(["multipart", done.size, await new Response((await files.get("out/clip.mp4"))!.body).text()]);
  const mp2 = await files.createMultipartUpload("out/gone.mp4");
  await files.resumeMultipartUpload("out/gone.mp4", mp2.uploadId).abort();
  out.push(["aborted", await files.head("out/gone.mp4")]);
  const page1 = await files.list({ limit: 2 });
  const page2 = await files.list({ limit: 2, cursor: page1.truncated ? page1.cursor : undefined });
  out.push(["list", page1.objects.map((o) => [o.key, o.size]), page1.truncated, page2.objects.map((o) => o.key), page2.truncated]);
  await files.delete(["raw/d1/a b.mov", "brain/doc"]);
  await files.delete("not-there");
  out.push(["after delete", (await files.list()).objects.map((o) => o.key)]);
  return out;
}

describe("Files on another Cloudflare account (S3)", () => {
  it("behaves like the R2 binding for every step the Worker uses", async () => {
    const r2 = await scenario(memoryR2().FILES);
    const s3 = fakeS3();
    const viaS3 = await scenario(new S3Files(cfg, s3.fetcher) as unknown as R2Bucket);
    expect(viaS3).toEqual(r2);
    // It really went over S3, signed, never hashing a payload in the Worker.
    expect(s3.seen.length).toBeGreaterThan(10);
    expect(s3.seen.every((r) => r.headers.get("x-amz-content-sha256") === "UNSIGNED-PAYLOAD")).toBe(true);
    expect(s3.seen.every((r) => r.url.startsWith("https://acct.r2.cloudflarestorage.com/her-bucket"))).toBe(true);
  });

  it("a refused write is an error, never a silent success", async () => {
    const files = new S3Files(cfg, fakeS3({ failPut: true }).fetcher) as unknown as R2Bucket;
    await expect(files.put("k", bytes("x"))).rejects.toThrow(/s3 put 500/);
    const bad = new S3Files({ ...cfg, bucket: "someone-elses" }, fakeS3().fetcher) as unknown as R2Bucket;
    await expect(bad.list()).rejects.toThrow(/s3 list 404/);
  });

  it("a download link is signed, time-limited and names the file; the binding gives none", async () => {
    const files = new S3Files(cfg, fakeS3().fetcher) as unknown as R2Bucket;
    const url = new URL((await signedDownload(files, "raw/d1/IMG 1.MOV", 3600, 'IMG "1".MOV'))!);
    expect(url.origin + url.pathname).toBe("https://acct.r2.cloudflarestorage.com/her-bucket/raw/d1/IMG%201.MOV");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="IMG _1_.MOV"');
    expect(await signedDownload(memoryR2().FILES, "k", 3600)).toBeNull();
  });

  it("is swapped in only when the studio says so, and a half-set studio is a named stop", () => {
    const binding = memoryR2().FILES;
    const base = { FILES: binding } as unknown as Env;
    expect(s3Config(base)).toBeNull();
    expect(filesFor(base)).toBe(binding);
    const full = { ...base, FILES_S3_BUCKET: "her-bucket", FILES_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", FILES_S3_ACCESS_KEY_ID: "A", FILES_S3_SECRET_ACCESS_KEY: "S" } as Env;
    expect(s3Config(full)).toEqual({ ...cfg, accessKeyId: "A", secretAccessKey: "S" });
    expect(filesFor(full)).toBeInstanceOf(S3Files);
    expect(() => filesFor({ ...full, FILES_S3_SECRET_ACCESS_KEY: "" } as Env)).toThrow(/FILES_S3_SECRETS_MISSING/);
  });
});
