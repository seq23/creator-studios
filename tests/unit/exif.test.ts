// A photo's camera EXIF (studio fix, 23 Oct 2026): a camera Make/Model = a real photo; none = an AI
// picture. Built byte by byte here for JPEG, HEIC-style (an Exif block inside the file) and PNG, and
// read at upload through the real route.
import { describe, expect, it } from "vitest";
import { readExif } from "@shared/exif";
import { harness } from "./helpers/studio-fix-env";

/** A little-endian TIFF block: IFD0 with Make, Model and an Exif pointer holding DateTimeOriginal. */
export function tiff(make: string | null, model: string | null, taken = "2026:10:22 14:03:09"): Uint8Array {
  const entries: [number, number, number, Uint8Array][] = [];
  const ascii = (s: string) => new TextEncoder().encode(`${s}\0`);
  if (make) entries.push([0x010f, 2, 0, ascii(make)]);
  if (model) entries.push([0x0110, 2, 0, ascii(model)]);
  entries.push([0x8769, 4, 1, new Uint8Array()]);
  const ifd0 = 8;
  const ifd0Size = 2 + entries.length * 12 + 4;
  let dataAt = ifd0 + ifd0Size;
  const buf = new Uint8Array(400);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 0x2a, 0x00]);
  dv.setUint32(4, ifd0, true);
  dv.setUint16(ifd0, entries.length, true);
  let exifIfd = 0;
  const blobs: [number, Uint8Array][] = [];
  entries.forEach(([tag, type, , data], i) => {
    const e = ifd0 + 2 + i * 12;
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, type, true);
    if (tag === 0x8769) {
      dv.setUint32(e + 4, 1, true);
      exifIfd = e + 8;
    } else {
      dv.setUint32(e + 4, data.length, true);
      dv.setUint32(e + 8, dataAt, true);
      blobs.push([dataAt, data]);
      dataAt += data.length;
    }
  });
  for (const [at, d] of blobs) buf.set(d, at);
  // The Exif sub-IFD: DateTimeOriginal.
  const sub = dataAt;
  dv.setUint32(exifIfd, sub, true);
  dv.setUint16(sub, 1, true);
  const t = ascii(taken);
  dv.setUint16(sub + 2, 0x9003, true);
  dv.setUint16(sub + 4, 2, true);
  dv.setUint32(sub + 6, t.length, true);
  dv.setUint32(sub + 10, sub + 18, true);
  buf.set(t, sub + 18);
  return buf.slice(0, sub + 18 + t.length);
}

export function jpegWith(t: Uint8Array | null): Uint8Array {
  const head = [0xff, 0xd8];
  if (!t) return new Uint8Array([...head, 0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xd9]);
  const app1 = new Uint8Array(2 + 2 + 6 + t.length);
  app1.set([0xff, 0xe1, ((t.length + 8) >> 8) & 0xff, (t.length + 8) & 0xff]);
  app1.set(new TextEncoder().encode("Exif\0\0"), 4);
  app1.set(t, 10);
  return new Uint8Array([...head, ...app1, 0xff, 0xd9]);
}

describe("reading a camera from a photo's first bytes", () => {
  it("JPEG with Make/Model and DateTimeOriginal", () => {
    expect(readExif(jpegWith(tiff("Apple", "iPhone 15 Pro")))).toEqual({ camera: true, make: "Apple", model: "iPhone 15 Pro", taken_at: "2026-10-22T14:03:09" });
  });
  it("JPEG with no EXIF, or EXIF with no camera, is an AI picture", () => {
    expect(readExif(jpegWith(null)).camera).toBe(false);
    expect(readExif(jpegWith(tiff(null, null))).camera).toBe(false);
  });
  it("HEIC-style: an Exif block somewhere inside the file", () => {
    const t = tiff("Apple", null);
    const heic = new Uint8Array(3000);
    heic.set(new TextEncoder().encode("\0\0\0\x18ftypheic"), 0);
    heic.set(new TextEncoder().encode("Exif\0\0"), 1200);
    heic.set(t, 1206);
    expect(readExif(heic)).toMatchObject({ camera: true, make: "Apple" });
  });
  it("PNG: an eXIf chunk; a PNG without one has no camera", () => {
    const t = tiff("Canon", "EOS R6");
    const png = new Uint8Array(8 + 13 + 12 + 12 + t.length);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR (13 bytes) then eXIf.
    new DataView(png.buffer).setUint32(8, 13);
    png.set(new TextEncoder().encode("IHDR"), 12);
    const at = 8 + 12 + 13;
    new DataView(png.buffer).setUint32(at, t.length);
    png.set(new TextEncoder().encode("eXIf"), at + 4);
    png.set(t, at + 8);
    expect(readExif(png)).toMatchObject({ camera: true, model: "EOS R6" });
    expect(readExif(png.slice(0, at)).camera).toBe(false);
  });
  it("never throws on junk", () => {
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2])).camera).toBe(false);
    expect(readExif(new Uint8Array(0)).camera).toBe(false);
  });
});

describe("a dump takes photos and videos together, full quality, and reads the camera at upload", () => {
  async function upload(h: Awaited<ReturnType<typeof harness>>, dumpId: string, name: string, mime: string, bytes: Uint8Array) {
    const start = await h.call("POST", "/api/uploads/start", { kind: "video", parentId: dumpId, fileName: name, size: bytes.length, mimeType: mime });
    expect(start.status, name).toBe(200);
    const part = await h.request("PUT", `/api/uploads/${start.json.id}/parts/1?key=${encodeURIComponent(start.json.key)}&uploadId=${encodeURIComponent(start.json.uploadId)}`, bytes, { "content-type": "application/octet-stream" });
    const etag = (await part.json()) as { partNumber: number; etag: string };
    expect((await h.call("POST", `/api/uploads/${start.json.id}/complete`, { key: start.json.key, uploadId: start.json.uploadId, parts: [etag] })).status).toBe(200);
    return start.json.id as string;
  }
  it("a camera photo, an AI picture (no camera), an iPhone HEIC with no type, and a video, in one dump", async () => {
    const h = await harness();
    h.db.raw.exec("INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_up', 'new', '', 'uploading')");
    const cam = await upload(h, "dmp_up", "finished.jpg", "image/jpeg", jpegWith(tiff("Apple", "iPhone 15")));
    const ai = await upload(h, "dmp_up", "reimagined.jpg", "image/jpeg", jpegWith(null));
    const heic = new Uint8Array(4000);
    heic.set(new TextEncoder().encode("Exif\0\0"), 900);
    heic.set(tiff("Apple", "iPhone 13"), 906);
    const hc = await upload(h, "dmp_up", "IMG_2210.HEIC", "application/octet-stream", heic);
    const vid = await upload(h, "dmp_up", "IMG_2211.MOV", "video/quicktime", new Uint8Array(500).fill(7));
    const row = (id: string) => h.one<{ exif_camera: number; mime_type: string; taken_at: string | null; upload_status: string }>("SELECT exif_camera, mime_type, taken_at, upload_status FROM assets WHERE id = ?", id);
    expect(row(cam)).toMatchObject({ exif_camera: 1, mime_type: "image/jpeg", taken_at: "2026-10-22T14:03:09", upload_status: "uploaded" });
    expect(row(ai).exif_camera).toBe(0);
    expect(row(hc)).toMatchObject({ exif_camera: 1, mime_type: "image/heic" });
    expect(row(vid)).toMatchObject({ exif_camera: 1, mime_type: "video/quicktime" });
    // Full quality: the bytes in storage are exactly the bytes sent.
    const stored = await h.r2.FILES.get(`raw/dmp_up/${hc}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(heic);
  });
  it("no size limit on a dump's files beyond what storage allows (a 4 GB video starts)", async () => {
    const h = await harness();
    h.db.raw.exec("INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_big', 'new', '', 'uploading')");
    expect((await h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_big", fileName: "long.mov", size: 4 * 1024 ** 3, mimeType: "video/quicktime" })).status).toBe(200);
    expect((await h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_big", fileName: "huge.jpg", size: 90 * 1024 ** 2, mimeType: "image/jpeg" })).status).toBe(200);
  });
});
