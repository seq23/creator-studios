// Start over with new files (worker/domain/startOver.ts addFilesRefusal): a finished dump takes a
// better set of the same job's files and its next Start over cuts them, instead of a parallel dump.
// Removing a file clips were made from never erases those clips (clips.asset_id cascades).
import { describe, expect, it } from "vitest";
import { addFilesRefusal } from "@worker/domain/startOver";
import { harness } from "./helpers/studio-fix-env";

describe("addFilesRefusal", () => {
  it("takes files while uploading and once finished; never while cut, never for a full video", () => {
    expect(addFilesRefusal({ status: "uploading", kind: "clips" })).toBeNull();
    for (const status of ["ready", "reviewed", "failed"]) expect(addFilesRefusal({ status, kind: "clips" }), status).toBeNull();
    for (const status of ["queued", "cutting"]) expect(addFilesRefusal({ status, kind: "clips" })?.status, status).toBe(409);
    expect(addFilesRefusal({ status: "ready", kind: "full_video" })?.status).toBe(409);
    expect(addFilesRefusal(null)?.status).toBe(404);
  });
});

describe("Start over with new files, end to end on the routes", () => {
  async function setup() {
    const h = await harness();
    h.db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_f', 'new', '', 'ready');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_old', 'dmp_f', 'old.mp4', 'video/mp4', 'raw/dmp_f/ast_old', 'uploaded');
      INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, r2_key, status) VALUES ('clp_draft', 'ast_old', 'dmp_f', 0, 5, 'montage', 'clips/dmp_f/d.mp4', 'draft'), ('clp_kept', 'ast_old', 'dmp_f', 0, 5, 'montage', 'clips/dmp_f/k.mp4', 'approved');`);
    await h.r2.FILES.put("raw/dmp_f/ast_old", new Uint8Array(10));
    return h;
  }
  it("a finished dump takes a new full-quality file; the old copy goes without erasing its clips; Start over cuts only the new one", async () => {
    const h = await setup();
    const bytes = new Uint8Array(600).fill(3);
    const start = await h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_f", fileName: "IMG_1.MOV", size: bytes.length, mimeType: "video/quicktime" });
    expect(start.status).toBe(200);
    const part = await h.request("PUT", `/api/uploads/${start.json.id}/parts/1?key=${encodeURIComponent(start.json.key)}&uploadId=${encodeURIComponent(start.json.uploadId)}`, bytes, { "content-type": "application/octet-stream" });
    expect((await h.call("POST", `/api/uploads/${start.json.id}/complete`, { key: start.json.key, uploadId: start.json.uploadId, parts: [await part.json()] })).status).toBe(200);

    expect((await h.call("DELETE", "/api/dumps/dmp_f/assets/ast_old")).status).toBe(200);
    expect(h.one<{ upload_status: string; raw_deleted_at: string | null }>("SELECT upload_status, raw_deleted_at FROM assets WHERE id = 'ast_old'")).toMatchObject({ upload_status: "aborted" });
    expect(h.one<{ raw_deleted_at: string | null }>("SELECT raw_deleted_at FROM assets WHERE id = 'ast_old'").raw_deleted_at).toBeTruthy();
    expect(await h.r2.FILES.head("raw/dmp_f/ast_old")).toBeNull();
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE dump_id = 'dmp_f'").n).toBe(2);

    const r = await h.call("POST", "/api/dumps/dmp_f/start-over", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ removed: 1, kept: 1 });
    expect(h.one<{ status: string }>("SELECT status FROM clips WHERE id = 'clp_kept'").status).toBe("approved");
    const live = h.db.raw.prepare("SELECT id FROM assets WHERE dump_id = 'dmp_f' AND upload_status = 'uploaded' AND raw_deleted_at IS NULL").all() as { id: string }[];
    expect(live.map((a) => a.id)).toEqual([start.json.id]);
  });
  it("refuses new files and removals while the dump is being cut", async () => {
    const h = await setup();
    h.db.raw.exec("UPDATE dumps SET status = 'cutting' WHERE id = 'dmp_f'");
    const start = await h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_f", fileName: "IMG_2.MOV", size: 10, mimeType: "video/quicktime" });
    expect(start.status).toBe(409);
    expect((await h.call("DELETE", "/api/dumps/dmp_f/assets/ast_old")).status).toBe(409);
    expect(h.one<{ upload_status: string }>("SELECT upload_status FROM assets WHERE id = 'ast_old'").upload_status).toBe("uploaded");
  });
});
