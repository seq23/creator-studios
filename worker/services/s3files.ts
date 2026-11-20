// A studio's files in an R2 bucket on ANOTHER Cloudflare account (owner, 20 Nov 2026: Hadiyah's
// files moved to the second account). A Worker binding cannot reach another account's bucket, so
// this speaks the S3 API (aws4fetch) and presents the same R2Bucket surface the rest of the Worker
// already uses: hydrate() (worker/lib/practice.ts) swaps env.FILES for it when the studio's
// registry entry says `r2.s3` (vars FILES_S3_BUCKET; secrets FILES_S3_ENDPOINT,
// FILES_S3_ACCESS_KEY_ID, FILES_S3_SECRET_ACCESS_KEY). Nothing else in the Worker changes.
//
// Payloads are never hashed in the Worker (UNSIGNED-PAYLOAD over TLS): a 10 MB part would cost the
// CPU budget. A stream body is read into memory before sending (S3 needs its length); every caller
// sends at most one upload part (10 MB) or one finished file this way.
import { AwsClient } from "aws4fetch";
import type { Env } from "../env";

export interface S3FilesConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The S3 settings when this studio's files live on another account; null when it uses its binding. Throws a named stop when half set. */
export function s3Config(env: Env): S3FilesConfig | null {
  if (!env.FILES_S3_BUCKET) return null;
  const endpoint = (env.FILES_S3_ENDPOINT ?? "").replace(/\/+$/, "");
  if (!endpoint || !env.FILES_S3_ACCESS_KEY_ID || !env.FILES_S3_SECRET_ACCESS_KEY) throw new Error("FILES_S3_SECRETS_MISSING: set FILES_S3_ENDPOINT, FILES_S3_ACCESS_KEY_ID and FILES_S3_SECRET_ACCESS_KEY (npm run studio:secrets <slug>)");
  return { endpoint, bucket: env.FILES_S3_BUCKET, accessKeyId: env.FILES_S3_ACCESS_KEY_ID, secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY };
}

type Body = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;
const UNSIGNED = { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" };
const encKey = (k: string) => k.split("/").map(encodeURIComponent).join("/");
const xml = (t: string, tag: string) => [...t.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const unq = (e: string | null) => (e ?? "").replace(/"/g, "");

async function bytesOf(body: Body): Promise<ArrayBuffer | string | Blob | ArrayBufferView | null> {
  if (body instanceof ReadableStream) return new Response(body).arrayBuffer();
  return body;
}

class S3Error extends Error {
  constructor(op: string, status: number) {
    super(`s3 ${op} ${status}`);
    this.name = "S3Error";
  }
}

/** An R2Object-shaped view of an S3 response. */
function objectFrom(key: string, res: Response, withBody: boolean): R2ObjectBody {
  const h = res.headers;
  const cr = h.get("content-range")?.match(/bytes (\d+)-(\d+)\/(\d+)/);
  const size = cr ? Number(cr[3]) : Number(h.get("content-length") ?? 0);
  const etag = unq(h.get("etag"));
  const httpMetadata: R2HTTPMetadata = {};
  if (h.get("content-type")) httpMetadata.contentType = h.get("content-type")!;
  if (h.get("cache-control")) httpMetadata.cacheControl = h.get("cache-control")!;
  if (h.get("content-disposition")) httpMetadata.contentDisposition = h.get("content-disposition")!;
  const customMetadata: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.startsWith("x-amz-meta-")) customMetadata[k.slice(11)] = v;
  });
  const obj = {
    key,
    version: h.get("x-amz-version-id") ?? "",
    size,
    etag,
    httpEtag: `"${etag}"`,
    uploaded: new Date(h.get("last-modified") ?? Date.now()),
    httpMetadata,
    customMetadata,
    checksums: {} as R2Checksums,
    storageClass: "Standard",
    range: cr ? { offset: Number(cr[1]), length: Number(cr[2]) - Number(cr[1]) + 1 } : undefined,
    writeHttpMetadata(headers: Headers) {
      for (const [k, v] of Object.entries({ "content-type": httpMetadata.contentType, "cache-control": httpMetadata.cacheControl, "content-disposition": httpMetadata.contentDisposition })) if (v) headers.set(k, v);
    },
    body: withBody ? res.body : null,
    bodyUsed: false,
    arrayBuffer: () => res.arrayBuffer(),
    text: () => res.text(),
    json: () => res.json(),
    blob: () => res.blob(),
  };
  return obj as unknown as R2ObjectBody;
}

function rangeHeader(r: R2GetOptions["range"]): string | null {
  if (!r) return null;
  if (r instanceof Headers) return r.get("range");
  if ("suffix" in r && r.suffix !== undefined) return `bytes=-${r.suffix}`;
  const o = r as { offset?: number; length?: number };
  const from = o.offset ?? 0;
  return o.length !== undefined ? `bytes=${from}-${from + o.length - 1}` : `bytes=${from}-`;
}

export class S3Files {
  private aws: AwsClient;
  constructor(
    private cfg: S3FilesConfig,
    fetcher: typeof fetch = fetch,
  ) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: "auto" });
    if (fetcher !== fetch) (this.aws as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> }).fetch = async (u, i) => fetcher(await this.aws.sign(u, i));
  }

  private url(key = "", query = ""): string {
    return `${this.cfg.endpoint}/${this.cfg.bucket}${key ? "/" + encKey(key) : ""}${query ? "?" + query : ""}`;
  }

  private send(url: string, init: RequestInit = {}): Promise<Response> {
    return this.aws.fetch(url, { ...init, headers: { ...UNSIGNED, ...(init.headers as Record<string, string> | undefined) } });
  }

  async head(key: string): Promise<R2Object | null> {
    const r = await this.send(this.url(key), { method: "HEAD" });
    if (r.status === 404) return null;
    if (!r.ok) throw new S3Error("head", r.status);
    return objectFrom(key, r, false);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const range = rangeHeader(options?.range);
    const r = await this.send(this.url(key), { headers: range ? { range } : {} });
    if (r.status === 404) return null;
    if (r.status === 416) return this.get(key);
    if (!r.ok) throw new S3Error("get", r.status);
    return objectFrom(key, r, true);
  }

  async put(key: string, value: Body, options?: R2PutOptions): Promise<R2Object> {
    const headers: Record<string, string> = {};
    if (options?.httpMetadata && !(options.httpMetadata instanceof Headers)) {
      if (options.httpMetadata.contentType) headers["content-type"] = options.httpMetadata.contentType;
      if (options.httpMetadata.cacheControl) headers["cache-control"] = options.httpMetadata.cacheControl;
      if (options.httpMetadata.contentDisposition) headers["content-disposition"] = options.httpMetadata.contentDisposition;
    }
    for (const [k, v] of Object.entries(options?.customMetadata ?? {})) headers[`x-amz-meta-${k}`] = v;
    const r = await this.send(this.url(key), { method: "PUT", body: (await bytesOf(value)) as BodyInit, headers });
    if (!r.ok) throw new S3Error("put", r.status);
    const after = await this.head(key);
    if (!after) throw new S3Error("put-head", 404);
    return after;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    await Promise.all(
      list.map(async (k) => {
        const r = await this.send(this.url(k), { method: "DELETE" });
        if (!r.ok && r.status !== 404) throw new S3Error("delete", r.status);
      }),
    );
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const q = new URLSearchParams({ "list-type": "2", "max-keys": String(options?.limit ?? 1000) });
    if (options?.prefix) q.set("prefix", options.prefix);
    if (options?.cursor) q.set("continuation-token", options.cursor);
    if (options?.startAfter) q.set("start-after", options.startAfter);
    const r = await this.send(this.url("", q.toString()));
    if (!r.ok) throw new S3Error("list", r.status);
    const t = await r.text();
    const objects = xml(t, "Contents").map((c) => {
      const etag = unq(unxml(xml(c, "ETag")[0] ?? ""));
      return { key: unxml(xml(c, "Key")[0] ?? ""), size: Number(xml(c, "Size")[0] ?? 0), etag, httpEtag: `"${etag}"`, uploaded: new Date(xml(c, "LastModified")[0] ?? 0) } as unknown as R2Object;
    });
    const next = xml(t, "NextContinuationToken")[0];
    const truncated = xml(t, "IsTruncated")[0] === "true";
    return (truncated && next ? { objects, truncated: true, cursor: unxml(next), delimitedPrefixes: [] } : { objects, truncated: false, delimitedPrefixes: [] }) as R2Objects;
  }

  async createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload> {
    const ct = options?.httpMetadata && !(options.httpMetadata instanceof Headers) ? options.httpMetadata.contentType : undefined;
    const r = await this.send(this.url(key, "uploads"), { method: "POST", headers: ct ? { "content-type": ct } : {} });
    if (!r.ok) throw new S3Error("create-multipart", r.status);
    const uploadId = unxml(xml(await r.text(), "UploadId")[0] ?? "");
    if (!uploadId) throw new S3Error("create-multipart-id", r.status);
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const id = encodeURIComponent(uploadId);
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: Body) => {
        const r = await this.send(this.url(key, `partNumber=${partNumber}&uploadId=${id}`), { method: "PUT", body: (await bytesOf(value)) as BodyInit });
        if (!r.ok) throw new S3Error("upload-part", r.status);
        return { partNumber, etag: unq(r.headers.get("etag")) };
      },
      complete: async (parts: R2UploadedPart[]) => {
        const body = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${unq(p.etag)}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        const r = await this.send(this.url(key, `uploadId=${id}`), { method: "POST", body, headers: { "content-type": "application/xml" } });
        const t = await r.text();
        // S3 may answer 200 with an <Error> body on complete.
        if (!r.ok || /<Error>/.test(t)) throw new S3Error("complete", r.status);
        const after = await this.head(key);
        if (!after) throw new S3Error("complete-head", 404);
        return after;
      },
      abort: async () => {
        const r = await this.send(this.url(key, `uploadId=${id}`), { method: "DELETE" });
        if (!r.ok && r.status !== 404) throw new S3Error("abort", r.status);
      },
    } as unknown as R2MultipartUpload;
  }

  /** A time-limited link anyone can open (downloads: a big file never streams through the Worker). */
  async signedUrl(key: string, seconds = 3600, fileName?: string): Promise<string> {
    const q = new URLSearchParams({ "X-Amz-Expires": String(Math.min(Math.max(seconds, 60), 7 * 86400)) });
    if (fileName) q.set("response-content-disposition", `attachment; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`);
    const req = await this.aws.sign(this.url(key, q.toString()), { method: "GET", aws: { signQuery: true, allHeaders: false } });
    return req.url;
  }
}

/** The studio's files: its own binding, or its bucket on another account. */
export function filesFor(env: Env, fetcher: typeof fetch = fetch): R2Bucket {
  const cfg = s3Config(env);
  return cfg ? (new S3Files(cfg, fetcher) as unknown as R2Bucket) : env.FILES;
}

/** A signed download link when the files are on another account; null when the binding serves them (the Worker streams instead). */
export async function signedDownload(files: R2Bucket, key: string, seconds: number, fileName?: string): Promise<string | null> {
  return files instanceof S3Files ? (files as S3Files).signedUrl(key, seconds, fileName) : null;
}
