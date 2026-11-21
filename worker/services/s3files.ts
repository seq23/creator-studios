// A studio's files in a bucket the Worker reaches over the S3 API (aws4fetch: SigV4 on
// crypto.subtle), presenting the same R2Bucket surface the rest of the Worker already uses.
// hydrate() (worker/lib/practice.ts) decides where env.FILES points:
//   - the creator's OWN storage (owner, 21 Nov 2026: Settings → Storage → Use your own storage):
//     her S3-compatible bucket (Cloudflare R2 or any S3 API), saved encrypted in the Setup key store
//     (connections service "storage"). LayeredFiles writes there and still reads (and deletes) what
//     is left on the host's storage, so nothing she made before goes missing.
//   - a bucket on the host's second Cloudflare account (`r2.s3`, Hadiyah since 20 Nov 2026: vars
//     FILES_S3_BUCKET; secrets FILES_S3_ENDPOINT, FILES_S3_ACCESS_KEY_ID, FILES_S3_SECRET_ACCESS_KEY).
//   - a studio that may not store on the host (registry hostStorageGb 0, Hadiyah) and has no
//     storage of its own: HostReadOnly refuses every write (OwnStorageNeeded), so nothing new lands
//     on the host's account.
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
  /** SigV4 region: "auto" for Cloudflare R2; read from the address for AWS-style hosts. */
  region?: string;
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

export class S3Error extends Error {
  constructor(
    op: string,
    readonly status: number,
  ) {
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
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: cfg.region || "auto" });
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

/** The studio's host files: its own binding, or its bucket on another account. */
export function filesFor(env: Env, fetcher: typeof fetch = fetch): R2Bucket {
  const cfg = s3Config(env);
  return cfg ? (new S3Files(cfg, fetcher) as unknown as R2Bucket) : env.FILES;
}

type Signer = { signedUrl(key: string, seconds: number, fileName?: string): Promise<string | null> };
const canSign = (f: unknown): f is Signer => typeof (f as Signer | null)?.signedUrl === "function";

/** A signed download link when the file is in an S3 bucket; null when a binding serves it (the Worker streams instead). */
export async function signedDownload(files: R2Bucket, key: string, seconds: number, fileName?: string): Promise<string | null> {
  return canSign(files) ? files.signedUrl(key, seconds, fileName) : null;
}

// ---------------------------------------------------------------- her own storage

/** The calm words when a studio with no host storage tries to save a file. */
export const OWN_STORAGE_NEEDED_WORDS = "Your studio keeps files in your own storage, and none is added yet. Open Settings → Storage → Use your own storage (Cloudflare R2 is free up to 10 GB), then try again.";

/** Thrown by HostReadOnly on any write: index.ts answers it with the calm words above (409), never a 500. */
export class OwnStorageNeeded extends Error {
  constructor() {
    super("OWN_STORAGE_NEEDED");
    this.name = "OwnStorageNeeded";
  }
}

/** What she pastes on Settings → Storage. */
export interface OwnStorageFields {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

/**
 * Her pasted fields as an S3 config, or the plain words for what is wrong. Pure. The address may be
 * a Cloudflare account id (32 hex), the R2 "S3 API" address (with or without /<bucket> on the end,
 * as the dashboard shows it), or any https S3 endpoint.
 */
export function ownStorageConfig(f: Partial<OwnStorageFields>): { ok: true; cfg: S3FilesConfig } | { ok: false; error: string } {
  const raw = String(f.endpoint ?? "").trim();
  let bucket = String(f.bucket ?? "").trim();
  const accessKeyId = String(f.access_key_id ?? "").trim();
  const secretAccessKey = String(f.secret_access_key ?? "").trim();
  if (!raw) return { ok: false, error: "Paste your Cloudflare account ID or the S3 API address." };
  let endpoint: string;
  if (/^[a-f0-9]{32}$/i.test(raw)) endpoint = `https://${raw.toLowerCase()}.r2.cloudflarestorage.com`;
  else {
    let u: URL;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return { ok: false, error: "That address does not look right. Paste the S3 API address from your bucket's settings, or just your account ID." };
    }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return { ok: false, error: "The address must start with https:// and have nothing after the bucket name." };
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    if (path && !path.includes("/") && !bucket) bucket = path;
    else if (path && path !== bucket) return { ok: false, error: "Paste the address without a folder on the end." };
    endpoint = `https://${u.host}`;
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { ok: false, error: "Type the bucket name exactly as it shows in your storage (lowercase letters, numbers and dashes)." };
  if (!accessKeyId || !secretAccessKey) return { ok: false, error: "Paste both the Access Key ID and the Secret Access Key." };
  const region = /(?:^|\.)s3[.-]([a-z]{2}-[a-z]+-\d+)\./.exec(new URL(endpoint).host)?.[1] ?? "auto";
  return { ok: true, cfg: { endpoint, bucket, accessKeyId, secretAccessKey, region } };
}

/** Plain words for a failed probe step. Pure. */
export function probeWords(step: "write" | "read" | "delete", e: unknown): string {
  const status = e instanceof S3Error ? e.status : 0;
  if (status === 401 || status === 403) return step === "write" ? "Your storage refused the key. Check the Access Key ID and Secret, and that the token has Object Read & Write on this bucket." : `Your storage let us write but not ${step}. Give the token Object Read & Write on this bucket.`;
  if (status === 404) return "That bucket was not found at that address. Check the bucket name and the account ID.";
  if (status === 0) return "We could not reach that storage address. Check it and try again.";
  return `Your storage answered with an error (${status}) on the ${step} step. Try again in a minute.`;
}

/**
 * Test connection: write a small probe file, read it back, delete it, and check it is gone. Nothing
 * else in her bucket is touched.
 */
export async function probeFiles(files: R2Bucket, now = Date.now()): Promise<{ ok: true } | { ok: false; step: "write" | "read" | "delete"; error: string }> {
  const key = `studio-check/${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const body = `Creator Studio storage check ${new Date(now).toISOString()}`;
  try {
    await files.put(key, body, { httpMetadata: { contentType: "text/plain" } });
  } catch (e) {
    return { ok: false, step: "write", error: probeWords("write", e) };
  }
  try {
    const got = await files.get(key);
    if (!got || new TextDecoder().decode(await got.arrayBuffer()) !== body) return { ok: false, step: "read", error: "The test file came back different. Check that the address is your storage's own S3 address." };
  } catch (e) {
    return { ok: false, step: "read", error: probeWords("read", e) };
  }
  try {
    await files.delete(key);
    if (await files.head(key)) return { ok: false, step: "delete", error: "The test file could not be deleted. Give the token Object Read & Write on this bucket." };
  } catch (e) {
    return { ok: false, step: "delete", error: probeWords("delete", e) };
  }
  return { ok: true };
}

/**
 * Her own storage first, the host's for what is still there: new files go to hers; a read or a
 * delete also reaches the host's copy, so files from before she switched still open and still clear
 * on the host's rules. Listing (the meter) asks each layer on its own (layersOf).
 */
export class LayeredFiles {
  constructor(
    readonly primary: R2Bucket,
    readonly fallback: R2Bucket,
  ) {}
  async head(key: string): Promise<R2Object | null> {
    return (await this.primary.head(key)) ?? (await this.fallback.head(key).catch(() => null));
  }
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    return (await this.primary.get(key, options)) ?? ((await this.fallback.get(key, options).catch(() => null)) as R2ObjectBody | null);
  }
  put(key: string, value: Body, options?: R2PutOptions): Promise<R2Object> {
    return this.primary.put(key, value as never, options) as Promise<R2Object>;
  }
  async delete(keys: string | string[]): Promise<void> {
    await this.primary.delete(keys);
    await this.fallback.delete(keys);
  }
  list(options?: R2ListOptions): Promise<R2Objects> {
    return this.primary.list(options);
  }
  createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload> {
    return this.primary.createMultipartUpload(key, options);
  }
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    return this.primary.resumeMultipartUpload(key, uploadId);
  }
  async signedUrl(key: string, seconds: number, fileName?: string): Promise<string | null> {
    return (await this.primary.head(key)) ? signedDownload(this.primary, key, seconds, fileName) : signedDownload(this.fallback, key, seconds, fileName);
  }
}

/** The host's files for a studio that may not store on the host: reads, lists and deletes only. */
export class HostReadOnly {
  constructor(readonly host: R2Bucket) {}
  head(key: string) {
    return this.host.head(key);
  }
  get(key: string, options?: R2GetOptions) {
    return this.host.get(key, options);
  }
  delete(keys: string | string[]) {
    return this.host.delete(keys);
  }
  list(options?: R2ListOptions) {
    return this.host.list(options);
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return this.host.resumeMultipartUpload(key, uploadId);
  }
  put(): Promise<R2Object> {
    return Promise.reject(new OwnStorageNeeded());
  }
  createMultipartUpload(): Promise<R2MultipartUpload> {
    return Promise.reject(new OwnStorageNeeded());
  }
  signedUrl(key: string, seconds: number, fileName?: string) {
    return signedDownload(this.host, key, seconds, fileName);
  }
}

/** Where each part of the studio's files lives, for the meter: her own bucket and/or the host's. */
export function layersOf(files: R2Bucket): { place: "own" | "host"; files: R2Bucket }[] {
  const f = files as unknown;
  if (f instanceof LayeredFiles) return [{ place: "own", files: f.primary }, { place: "host", files: f.fallback }];
  if (f instanceof HostReadOnly) return [{ place: "host", files: f.host }];
  return [{ place: "host", files }];
}
