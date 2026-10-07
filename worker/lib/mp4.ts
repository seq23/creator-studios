// Read a video's picture size and length from its MP4 / MOV header, in the Worker, without
// decoding anything (the Worker has no ffmpeg). Enough to refuse her uploaded edit at once when
// it is not a tall 9:16 video or too long for a platform; the cut job's import mode measures the
// file again with ffprobe before it replaces anything. Pure parser + one R2 reader, unit-tested
// (tests/unit/editors.test.ts). ISO BMFF: top-level boxes [size][type]; `moov` holds `mvhd`
// (timescale, duration) and one `trak` per stream: `tkhd` (width, height, rotation matrix) and
// `mdia/hdlr` (handler "vide" for video).

export interface VideoProbe {
  width: number;
  height: number;
  duration_s: number;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = start;
  let guard = 0;
  while (o + 8 <= end && guard++ < 4096) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = Number(dv.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}

function child(b: Uint8Array, parent: Box, type: string): Box | null {
  for (const x of boxes(b, parent.start, parent.end)) if (x.type === type) return x;
  return null;
}

/** The moov box's contents (its header included) → the first video track's size and the length. */
export function parseMoov(moovBox: Uint8Array): VideoProbe | null {
  const top = [...boxes(moovBox, 0, moovBox.byteLength)].find((x) => x.type === "moov");
  if (!top) return null;
  const dv = new DataView(moovBox.buffer, moovBox.byteOffset, moovBox.byteLength);
  let timescale = 0;
  let duration = 0;
  const mvhd = child(moovBox, top, "mvhd");
  if (mvhd) {
    const v = moovBox[mvhd.start];
    if (v === 1) {
      timescale = dv.getUint32(mvhd.start + 20);
      duration = Number(dv.getBigUint64(mvhd.start + 24));
    } else {
      timescale = dv.getUint32(mvhd.start + 12);
      duration = dv.getUint32(mvhd.start + 16);
    }
  }
  for (const trak of boxes(moovBox, top.start, top.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(moovBox, trak, "mdia");
    const hdlr = mdia ? child(moovBox, mdia, "hdlr") : null;
    const handler = hdlr ? String.fromCharCode(...moovBox.subarray(hdlr.start + 8, hdlr.start + 12)) : "";
    if (handler !== "vide") continue;
    const tkhd = child(moovBox, trak, "tkhd");
    if (!tkhd) continue;
    const v = moovBox[tkhd.start];
    const matrixAt = tkhd.start + (v === 1 ? 52 : 40);
    const a = dv.getInt32(matrixAt);
    const bb = dv.getInt32(matrixAt + 4);
    let width = Math.round(dv.getUint32(matrixAt + 36) / 65536);
    let height = Math.round(dv.getUint32(matrixAt + 40) / 65536);
    // A phone video filmed upright is often stored sideways with a 90° rotation matrix.
    if (a === 0 && Math.abs(bb) === 65536) [width, height] = [height, width];
    if (!width || !height) continue;
    let secs = timescale ? duration / timescale : 0;
    if (!secs) {
      const tkDur = v === 1 ? Number(dv.getBigUint64(tkhd.start + 28)) : dv.getUint32(tkhd.start + 20);
      secs = timescale ? tkDur / timescale : 0;
    }
    return { width, height, duration_s: Math.round(secs * 1000) / 1000 };
  }
  return null;
}

/** Longest `moov` read: a 10-minute phone video's header is well under this. */
export const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** Find the moov box in an R2 object by walking the top-level box headers with small range reads. */
export async function probeR2(files: R2Bucket, key: string): Promise<VideoProbe | null> {
  const head = await files.head(key);
  if (!head) return null;
  let offset = 0;
  for (let i = 0; i < 64 && offset + 8 <= head.size; i++) {
    const hdr = await files.get(key, { range: { offset, length: Math.min(16, head.size - offset) } });
    if (!hdr) return null;
    const b = new Uint8Array(await hdr.arrayBuffer());
    const dv = new DataView(b.buffer);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (size === 1 && b.byteLength >= 16) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = head.size - offset;
    if (size < 8) return null;
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) return null;
      const moov = await files.get(key, { range: { offset, length: size } });
      return moov ? parseMoov(new Uint8Array(await moov.arrayBuffer())) : null;
    }
    offset += size;
  }
  return null;
}
