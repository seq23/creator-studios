// A finished upload always moves on (20 Nov 2026). The real case: Hadiyah's dump of 13 Oct (the
// Recycle door, one 5.38 GB video) finished uploading but only the button could send it; it sat in
// 'uploading' for five weeks and the tidy archived it. sendIdleDumps (worker/routes/dumps.ts) sends it.
import { describe, expect, it } from "vitest";
import { IDLE_SEND_HOURS, sendIdleDumps } from "@worker/routes/dumps";
import { harness } from "./helpers/studio-fix-env";

const CREATED = "2026-10-13T17:41:52.961Z";
const at = (hours: number) => new Date(Date.parse(CREATED) + hours * 3600_000);

async function realCase(archivedBy: "tidy" | "her" | null = "tidy", uploadStatus = "uploaded") {
  const h = await harness();
  h.db.raw.exec(`INSERT INTO dumps (id, door, kind, notes, status, created_at${archivedBy ? ", archived_at, archived_by" : ""}) VALUES ('dmp_od91', 'recycle', 'clips', '', 'uploading', '${CREATED}'${archivedBy ? `, '2026-11-13T13:30:33.147Z', '${archivedBy}'` : ""})`);
  h.db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, size_bytes, r2_key, upload_status, created_at) VALUES ('ast_rx', 'dmp_od91', 'IMG_0001.MOV', 'video/quicktime', 5384288455, 'raw/dmp_od91/ast_rx', ?, '2026-10-13T17:41:53.723Z')").run(uploadStatus);
  await h.r2.FILES.put("raw/dmp_od91/ast_rx", new Uint8Array(100).fill(7), { httpMetadata: { contentType: "video/quicktime" } });
  const dump = () => h.one<{ status: string; archived_at: string | null }>("SELECT status, archived_at FROM dumps WHERE id = 'dmp_od91'");
  return { h, dump };
}

describe("a finished upload is sent even if the button was never tapped", () => {
  it("the real case: sent once after the idle hours, back out of the archive, a cut job started, her file untouched", async () => {
    const { h, dump } = await realCase();
    expect(await sendIdleDumps(h.env, at(IDLE_SEND_HOURS - 1))).toMatchObject({ checked: 0, sent: 0 });
    expect(dump().status).toBe("uploading");
    expect(await sendIdleDumps(h.env, at(24 * 38))).toMatchObject({ checked: 1, sent: 1, stalled: 0 });
    expect(dump().status).not.toBe("uploading");
    expect(dump().archived_at).toBeNull();
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE ref_id = 'dmp_od91' AND type = 'cut'").n).toBe(1);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'dump.auto_sent_idle' AND ref_id = 'dmp_od91'").n).toBe(1);
    expect(await h.r2.FILES.head("raw/dmp_od91/ast_rx")).not.toBeNull();
    // Once only.
    expect(await sendIdleDumps(h.env, at(24 * 39))).toMatchObject({ checked: 0, sent: 0 });
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE ref_id = 'dmp_od91'").n).toBe(1);
  });

  it("never one she put away herself", async () => {
    const { h, dump } = await realCase("her");
    expect(await sendIdleDumps(h.env, at(24 * 38))).toMatchObject({ checked: 0, sent: 0 });
    expect(dump().status).toBe("uploading");
  });

  it("a file that stopped uploading is not sent, and is flagged within a day", async () => {
    const { h, dump } = await realCase(null, "uploading");
    await sendIdleDumps(h.env, at(12));
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = 'Uploads'").light).toBe("green");
    expect(await sendIdleDumps(h.env, at(25))).toMatchObject({ sent: 0, stalled: 1 });
    expect(dump().status).toBe("uploading");
    expect(h.one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'Uploads'")).toEqual({ light: "yellow", fix_guide: "dump-new-footage" });
  });
});
