// What I dumped (studio fix, 23 Oct 2026): every file of a dump, each with a picture to view, the
// stage the engine gave it, which clips used it (by number), and the day its original is cleared.
import { describe, expect, it } from "vitest";
import { clearsOn, roleLabel } from "@worker/lib/dumpFiles";
import { harness } from "./helpers/studio-fix-env";

describe("What I dumped", () => {
  it("lists photos and videos with role, the clips that used them, camera, and the clear date", async () => {
    const h = await harness();
    await h.dumpWith("dmp_f", [
      { id: "ast_fv", name: "IMG_1.MOV", mime: "video/quicktime", exif: 1 },
      { id: "ast_fv2", name: "IMG_2.MOV", mime: "video/quicktime", exif: 1 },
      { id: "ast_fp", name: "new-final.jpg", mime: "image/jpeg", exif: 0 },
    ]);
    await h.cut("dmp_f", undefined, 3);
    const r = await h.call("GET", "/api/dumps/dmp_f/files");
    expect(r.status).toBe(200);
    const files = r.json.files as { id: string; kind: string; role_label: string; camera: boolean; used_by: { code: string; label: string; hero: boolean }[]; view_url: string; clears_on: string }[];
    expect(files.map((f) => f.kind)).toEqual(["video", "video", "photo"]);
    const photo = files.find((f) => f.id === "ast_fp")!;
    // The fake engine ends every clip on the dump's photo: the hero of clips 1, 2 and 3.
    expect(photo.role_label).toBe("Best finished shot (ends clips)");
    expect(photo.camera).toBe(false);
    expect(photo.used_by.map((u) => u.code)).toEqual(["1", "2", "3"]);
    expect(photo.used_by.every((u) => u.hero)).toBe(true);
    expect(photo.used_by[0].label).toBe("Oct 22 · Clip 1");
    // The clips were AI-image clips (no camera EXIF on the photo), so they are marked.
    expect(h.all<{ uses_ai_images: number }>("SELECT uses_ai_images FROM clips WHERE dump_id = 'dmp_f'").every((c) => c.uses_ai_images === 1)).toBe(true);
    const ready = h.one<{ ready_at: string }>("SELECT ready_at FROM dumps WHERE id = 'dmp_f'").ready_at;
    expect(photo.clears_on).toBe(clearsOn(ready));
    // Each file opens on her own screens, while it is kept.
    const view = await h.request("GET", photo.view_url);
    expect(view.status).toBe(200);
    h.db.raw.exec("UPDATE assets SET raw_deleted_at = '2026-10-30T00:00:00Z' WHERE id = 'ast_fp'");
    const later = (await h.call("GET", "/api/dumps/dmp_f/files")).json.files.find((f: { id: string }) => f.id === "ast_fp");
    expect(later).toMatchObject({ view_url: null, cleared: true, clears_on: "2026-10-30" });
    expect((await h.request("GET", photo.view_url)).status).toBe(404);
  });
  it("a file in another dump is never served through this one; plain role words", async () => {
    const h = await harness();
    await h.dumpWith("dmp_x", [{ id: "ast_x", name: "a.mp4", mime: "video/mp4" }]);
    await h.dumpWith("dmp_y", [{ id: "ast_y", name: "b.mp4", mime: "video/mp4" }]);
    expect((await h.request("GET", "/api/dumps/dmp_y/files/ast_x/view")).status).toBe(404);
    expect((await h.call("GET", "/api/dumps/dmp_nope/files")).status).toBe(404);
    expect(roleLabel("prep")).toBe("Getting ready");
    expect(roleLabel("hero")).toMatch(/ends clips/);
    expect(roleLabel("odd_stage")).toBe("odd stage");
    expect(clearsOn(null)).toBeNull();
    expect(clearsOn("2026-10-22T15:00:00.000Z")).toBe("2026-10-30");
  });
});
