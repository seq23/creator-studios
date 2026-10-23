// Did a camera take this picture? (studio fix, 23 Oct 2026). A photo with a camera Make or Model in
// its EXIF is a real photo; one with neither is treated as an AI picture, and the clips that use it
// say "Made with AI" (studio setting ai_note = "ai_images"). Read from the first bytes of the file
// at upload, for JPEG (APP1 "Exif"), HEIC/HEIF (the Exif item, a TIFF block in the file) and PNG
// (an eXIf chunk). Also returns when it was taken (DateTimeOriginal), so the clip engine can keep
// one event's photos together. Pure, no dependencies. Guard: tests/unit/exif.test.ts.

export interface ExifRead {
  /** A camera Make or Model is present. */
  camera: boolean;
  make: string | null;
  model: string | null;
  /** "2026-10-22T14:03:09" (camera local time, no zone), or null. */
  taken_at: string | null;
}

export const NO_EXIF: ExifRead = { camera: false, make: null, model: null, taken_at: null };

/** How many bytes the Worker reads from the start of a photo to find its EXIF. */
export const EXIF_SCAN_BYTES = 512 * 1024;

function asciiAt(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && off + i < b.length; i++) {
    const c = b[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Parse one TIFF block (byte order, IFD0, the Exif sub-IFD). Null when it is not a TIFF header. */
export function readTiff(b: Uint8Array, t: number): ExifRead | null {
  if (t + 8 > b.length) return null;
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  const be = b[t] === 0x4d && b[t + 1] === 0x4d;
  if (!le && !be) return null;
  const u16 = (o: number) => (o + 2 > b.length ? -1 : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (o + 4 > b.length ? -1 : le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  if (u16(t + 2) !== 42) return null;
  const out: ExifRead = { ...NO_EXIF };
  const str = (entry: number): string | null => {
    const count = u32(entry + 4);
    if (count <= 0 || count > 256) return null;
    const at = count <= 4 ? entry + 8 : t + u32(entry + 8);
    const s = asciiAt(b, at, count);
    return s || null;
  };
  let exifIfd = -1;
  const walk = (ifd: number, sub: boolean) => {
    const n = u16(ifd);
    if (n <= 0 || n > 500) return;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > b.length) return;
      const tag = u16(e);
      if (!sub && tag === 0x010f) out.make = str(e);
      else if (!sub && tag === 0x0110) out.model = str(e);
      else if (!sub && tag === 0x8769) exifIfd = t + u32(e + 8);
      else if (sub && tag === 0x9003) {
        const d = str(e);
        const m = d ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(d) : null;
        if (m) out.taken_at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
      }
    }
  };
  const first = u32(t + 4);
  if (first < 8) return null;
  walk(t + first, false);
  if (exifIfd > t && exifIfd < b.length) walk(exifIfd, true);
  out.camera = !!(out.make || out.model);
  return out;
}

/** The EXIF of a photo from its first bytes; NO_EXIF when there is none. Pure. */
export function readExif(bytes: Uint8Array): ExifRead {
  const b = bytes;
  // JPEG: walk the segments to APP1 "Exif\0\0".
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 < b.length && b[o] === 0xff) {
      const marker = b[o + 1];
      const len = (b[o + 2] << 8) | b[o + 3];
      if (marker === 0xe1 && asciiAt(b, o + 4, 4) === "Exif") return readTiff(b, o + 10) ?? NO_EXIF;
      if (marker === 0xda || len < 2) break;
      o += 2 + len;
    }
    return NO_EXIF;
  }
  // PNG: an eXIf chunk holds a bare TIFF block.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    let o = 8;
    while (o + 8 < b.length) {
      const len = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const type = asciiAt(b, o + 4, 4);
      if (type === "eXIf") return readTiff(b, o + 8) ?? NO_EXIF;
      if (type === "IDAT" || type === "IEND") break;
      o += 12 + len;
    }
    return NO_EXIF;
  }
  // HEIC / HEIF and anything else: the first "Exif\0\0" or bare TIFF header that parses.
  for (let i = 0; i + 10 < b.length; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) {
      const r = readTiff(b, i + 6);
      if (r) return r;
    }
  }
  for (let i = 0; i + 8 < b.length; i++) {
    if ((b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0) || (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a)) {
      const r = readTiff(b, i);
      if (r && r.camera) return r;
    }
  }
  return NO_EXIF;
}
