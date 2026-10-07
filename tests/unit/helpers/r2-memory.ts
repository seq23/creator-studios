// An in-memory R2Bucket stand-in covering what the job storage routes use: get (with a Range
// header), head, put, list (paged), and multipart create / resume / uploadPart / complete / abort. Parts are
// read from the request stream, so a test proves the route hands R2 the stream it received.
type Stored = { bytes: Uint8Array; contentType: string | undefined };

async function readAll(body: ReadableStream | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function parseRange(h: Headers | undefined, size: number): { offset: number; length: number } | undefined {
  const v = h?.get("range");
  const m = v?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return undefined;
  if (m[1] === "") {
    const n = Math.min(size, Number(m[2]));
    return { offset: size - n, length: n };
  }
  const offset = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  return { offset, length: end - offset + 1 };
}

export function memoryR2() {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; contentType?: string; parts: Map<number, Uint8Array> }>();
  let seq = 0;

  const objectFor = (key: string, s: Stored, range?: { offset: number; length: number }) => {
    const bytes = range ? s.bytes.slice(range.offset, range.offset + range.length) : s.bytes;
    return {
      key,
      size: s.bytes.byteLength,
      httpEtag: `"etag-${key.length}-${s.bytes.byteLength}"`,
      range,
      httpMetadata: { contentType: s.contentType },
      body: new Response(bytes).body,
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
      writeHttpMetadata(h: Headers) {
        if (s.contentType) h.set("content-type", s.contentType);
      },
    };
  };

  const bucket = {
    async get(key: string, opts?: { range?: Headers | { offset: number; length?: number } }) {
      const s = objects.get(key);
      if (!s) return null;
      const r = opts?.range;
      if (r && !(r instanceof Headers) && typeof r.offset === "number") {
        const length = Math.min(r.length ?? s.bytes.byteLength - r.offset, s.bytes.byteLength - r.offset);
        return objectFor(key, s, { offset: r.offset, length });
      }
      return objectFor(key, s, parseRange(r as Headers | undefined, s.bytes.byteLength));
    },
    async head(key: string) {
      const s = objects.get(key);
      return s ? { key, size: s.bytes.byteLength, httpMetadata: { contentType: s.contentType } } : null;
    },
    async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: await readAll(body), contentType: opts?.httpMetadata?.contentType });
      return { key };
    },
    async createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }) {
      const uploadId = `up-${++seq}`;
      uploads.set(uploadId, { key, contentType: opts?.httpMetadata?.contentType, parts: new Map() });
      return { key, uploadId };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return {
        key,
        uploadId,
        async uploadPart(n: number, body: ReadableStream) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) throw new Error("NoSuchUpload");
          u.parts.set(n, await readAll(body));
          return { partNumber: n, etag: `p${n}` };
        },
        async complete(parts: { partNumber: number; etag: string }[]) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) throw new Error("NoSuchUpload");
          const pieces = parts.map((p) => u.parts.get(p.partNumber) ?? new Uint8Array());
          const bytes = await readAll(new Blob(pieces).stream());
          objects.set(key, { bytes, contentType: u.contentType });
          uploads.delete(uploadId);
          return { key, size: bytes.byteLength };
        },
        async abort() {
          uploads.delete(uploadId);
        },
      };
    },
    /** Paged like R2 (limit, cursor = the next index), sorted by key. */
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).sort();
      const from = Number(opts?.cursor ?? 0);
      const limit = Math.min(opts?.limit ?? 1000, 1000);
      const page = keys.slice(from, from + limit);
      const truncated = from + limit < keys.length;
      return { objects: page.map((k) => ({ key: k, size: objects.get(k)!.bytes.byteLength })), truncated, cursor: truncated ? String(from + limit) : undefined };
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
    },
  };
  return { FILES: bucket as unknown as R2Bucket, objects, uploads };
}
