// A tiny MP4 header for tests: ftyp + moov (mvhd, one video trak with tkhd + mdia/hdlr) + mdat.
// No real frames; enough for worker/lib/mp4.ts to read the size, rotation and length the way it
// reads a phone's export. `moovLast` puts the moov after mdat, as many apps write it.
function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function u64(n: number): number[] {
  return [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
}
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
}
const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);
const ROT90 = [0, 0x10000, 0, -0x10000 >>> 0, 0, 0, 0, 0, 0x40000000].flatMap(u32);

export function buildMp4(o: { width: number; height: number; duration_s: number; timescale?: number; rotate90?: boolean; moovLast?: boolean; version1?: boolean; mdatBytes?: number }): Uint8Array {
  const ts = o.timescale ?? 1000;
  const dur = Math.round(o.duration_s * ts);
  const v1 = !!o.version1;
  const mvhd = box("mvhd", v1 ? [1, 0, 0, 0, ...u64(0), ...u64(0), ...u32(ts), ...u64(dur)] : [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(ts), ...u32(dur)], u32(0x10000), [1, 0], new Array(10).fill(0), IDENTITY, new Array(24).fill(0), u32(2));
  const matrix = o.rotate90 ? ROT90 : IDENTITY;
  const tkhd = box(
    "tkhd",
    v1 ? [1, 0, 0, 3, ...u64(0), ...u64(0), ...u32(1), ...u32(0), ...u64(dur)] : [0, 0, 0, 3, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(dur)],
    new Array(8).fill(0),
    [0, 0, 0, 0, 0, 0, 0, 0],
    matrix,
    u32(o.width * 65536),
    u32(o.height * 65536),
  );
  const hdlr = box("hdlr", [0, 0, 0, 0], u32(0), [..."vide"].map((c) => c.charCodeAt(0)), new Array(12).fill(0), [0]);
  const soun = box("trak", box("tkhd", [0, 0, 0, 3], new Array(80).fill(0)), box("mdia", box("hdlr", [0, 0, 0, 0], u32(0), [..."soun"].map((c) => c.charCodeAt(0)), new Array(12).fill(0), [0])));
  const moov = box("moov", mvhd, soun, box("trak", tkhd, box("mdia", hdlr)));
  const ftyp = box("ftyp", [..."isom"].map((c) => c.charCodeAt(0)), u32(0x200), [..."isomiso2avc1mp41"].map((c) => c.charCodeAt(0)));
  const mdat = box("mdat", new Array(o.mdatBytes ?? 64).fill(7));
  return new Uint8Array(o.moovLast ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}
