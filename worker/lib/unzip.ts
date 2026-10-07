// A minimal zip reader for the Worker (no dependency): TikTok Studio's "Download data → CSV"
// hands her a .zip with the CSV inside (proven 25 Sep 2026: Content_<handle>.zip → Content.csv).
// Reads the central directory, then each entry's local header; method 0 (stored) is copied,
// method 8 (deflate) is inflated with the platform's DecompressionStream("deflate-raw"), which
// the Workers runtime and Node both have. Anything else (zip64, encryption, other methods) is
// reported as unreadable, never guessed.

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  encrypted: boolean;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** True for bytes that start like a zip file ("PK\x03\x04", or an empty zip's "PK\x05\x06"). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

/** The entries listed in the central directory; throws on a file that is not a readable zip. */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 22 + 65535 (comment) bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CEN) throw new Error("broken zip directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compressedSize, size, offset, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The bytes of one entry, inflated. Throws on an encrypted entry or an unknown method. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new Error("encrypted zip entry");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LOC) throw new Error("broken zip entry");
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method !== 8) throw new Error(`zip method ${entry.method}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An Excel workbook is a zip too; it always carries [Content_Types].xml and an xl/ folder. */
export function looksLikeXlsx(entries: ZipEntry[]): boolean {
  return entries.some((e) => e.name === "[Content_Types].xml") || entries.some((e) => e.name.startsWith("xl/"));
}

/** The CSV files in the zip (folders and macOS "__MACOSX/._x" shadows skipped). */
export function csvEntries(entries: ZipEntry[]): ZipEntry[] {
  return entries.filter((e) => /\.csv$/i.test(e.name) && !e.name.startsWith("__MACOSX/") && !/(^|\/)\._/.test(e.name));
}
