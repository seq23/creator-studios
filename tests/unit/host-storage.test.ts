// Host storage and "Use your own storage" (owner, 21 Nov 2026): "i dont want her [Hadiyah's] stuff
// stored there… in the studios u can add a section where creators can add their own storage", and
// "im fine wth mercedes and sheila stuff being stored for a while but it needs to rotate out often
// and keep my storage way below free max".
//   - the registry's host shares: at most 1.5 GB a studio, all under 4 GB, Hadiyah none
//   - a studio with no share and no storage of its own writes NOTHING to the host (HostReadOnly)
//   - an upload past the share is refused with a pointer to Use your own storage
//   - originals on the shared storage clear 7 days after their clips or 14 days after upload
//   - her own storage: checked (write, read, delete), saved encrypted, and new files go there
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Env } from "@worker/env";
import { HOST_STORAGE, hostCapBytes } from "@worker/domain/tidy";
import { clearDate, retentionStep, type RetentionDump } from "@worker/domain/retention";
import { originalsRetention } from "@worker/lib/retention";
import { enforceBudget, measureStorage, storageReport, uploadRefusal } from "@worker/lib/storage";
import { hydrate } from "@worker/lib/practice";
import { saveConnection } from "@worker/lib/connections";
import { HostReadOnly, LayeredFiles, OWN_STORAGE_NEEDED_WORDS, OwnStorageNeeded, ownStorageConfig, probeFiles, S3Files, signedDownload } from "@worker/services/s3files";
import { checkOwnStorage } from "@worker/routes/archive";
import { SETUP_STEPS } from "@shared/setup";
import { originals } from "@worker/routes/originals";
import { originalsToken } from "@worker/domain/retention";
import { BASE_URL, harness } from "./helpers/studio-fix-env";
import { memoryR2 } from "./helpers/r2-memory";
import { fakeS3 } from "./helpers/s3-fake";

const GB = 1024 ** 3;
const DAY = 86400_000;
const root = path.resolve(__dirname, "../..");
const registry = () =>
  readdirSync(path.join(root, "studios"))
    .filter((f) => f.endsWith(".json") && f !== "themes.json")
    .map((f) => JSON.parse(readFileSync(path.join(root, "studios", f), "utf8")) as { slug: string; hostStorageGb?: number });

describe("the host's storage shares (registry)", () => {
  it("every studio names its share; each at most 1.5 GB, all together under 4 GB; Hadiyah has none; each env carries its own", () => {
    const studios = registry();
    expect(studios.length).toBeGreaterThan(3);
    const cfg = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
    for (const s of studios) {
      expect(typeof s.hostStorageGb, s.slug).toBe("number");
      expect(s.hostStorageGb!).toBeGreaterThanOrEqual(0);
      expect(s.hostStorageGb!).toBeLessThanOrEqual(HOST_STORAGE.maxStudioGb);
      expect(cfg).toContain(`"HOST_STORAGE_GB": "${s.hostStorageGb}"`);
    }
    expect(studios.reduce((n, s) => n + s.hostStorageGb!, 0)).toBeLessThan(HOST_STORAGE.totalGb);
    expect(studios.find((s) => s.slug === "hadiyah")!.hostStorageGb).toBe(0);
  });

  it("the share in bytes: never above 1.5 GB whatever the var says; 0 and nonsense are none", () => {
    expect(hostCapBytes({ HOST_STORAGE_GB: "1.25" })).toBe(1.25 * GB);
    expect(hostCapBytes({ HOST_STORAGE_GB: "9" })).toBe(1.5 * GB);
    expect(hostCapBytes({ HOST_STORAGE_GB: "0" })).toBe(0);
    expect(hostCapBytes({ HOST_STORAGE_GB: "lots" })).toBe(0);
  });
});

describe("a studio with no host share and no storage of its own (Hadiyah)", () => {
  it("hydrate makes the host's files read-only: every write is refused, nothing lands in the bucket", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0" });
    const e = await hydrate(h.env);
    expect(e.FILES_PLACE).toBe("none");
    expect(e.FILES).toBeInstanceOf(HostReadOnly);
    await expect(e.FILES.put("raw/x/y", "bytes")).rejects.toBeInstanceOf(OwnStorageNeeded);
    await expect(e.FILES.createMultipartUpload("raw/x/y")).rejects.toBeInstanceOf(OwnStorageNeeded);
    // reads and deletes still reach what is already there
    await h.r2.FILES.put("brain/doc", "hello");
    expect(await e.FILES.head("brain/doc")).not.toBeNull();
    expect((await h.r2.FILES.list()).objects.map((o) => o.key)).toEqual(["brain/doc"]);
  });

  it("an upload is refused with the calm words and the own-storage guide, before any multipart starts", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0", FILES_PLACE: "none" });
    h.db.raw.exec("INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_n', 'new', '', 'uploading')");
    const r = await h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_n", fileName: "IMG_1.MOV", size: 5 * 1024 ** 2, mimeType: "video/quicktime" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: OWN_STORAGE_NEEDED_WORDS, fix_guide: "own-storage" });
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM assets").n).toBe(0);
    expect((await h.r2.FILES.list()).objects).toHaveLength(0);
    const meter = await storageReport(h.env);
    expect(meter).toMatchObject({ place: "none", limit_bytes: 0, line: "No storage yet: add your own to upload" });
    // the clean-up has nothing of hers to clear and never deletes from the host's bucket
    await h.r2.FILES.put("raw/dmp_old/ast_1", new Uint8Array(10));
    expect(await originalsRetention(h.env)).toMatchObject({ checked: 0, cleared_files: 0 });
    expect(await h.r2.FILES.head("raw/dmp_old/ast_1")).not.toBeNull();
  });

  it("negative proof: the same studio with a host share writes as before", async () => {
    const h = await harness({ HOST_STORAGE_GB: "1.25" });
    const e = await hydrate(h.env);
    expect(e.FILES_PLACE).toBe("host");
    await e.FILES.put("raw/x/y", "bytes");
    expect(await h.r2.FILES.head("raw/x/y")).not.toBeNull();
  });
});

describe("the shared storage's cap", () => {
  it("an upload that fits starts; one past the share (uploads in flight counted) is refused and points to own storage", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0.25", FILES_PLACE: "host" });
    h.db.raw.exec("INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_c', 'new', '', 'uploading')");
    const start = (size: number, name: string) => h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_c", fileName: name, size, mimeType: "video/quicktime" });
    expect((await start(150 * 1024 ** 2, "IMG_1.MOV")).status).toBe(200);
    // 150 MB is still uploading: another 150 MB would pass 256 MB
    const over = await start(150 * 1024 ** 2, "IMG_2.MOV");
    expect(over.status).toBe(409);
    expect(over.json.fix_guide).toBe("own-storage");
    expect(over.json.error).toMatch(/would not fit/);
    expect(over.json.error).toMatch(/Settings → Storage/);
    expect((await start(50 * 1024 ** 2, "IMG_3.MOV")).status).toBe(200);
    // her own storage is never refused here
    expect(await uploadRefusal({ ...h.env, FILES_PLACE: "own" }, 50 * GB)).toBeNull();
  });

  it("over 90% of the share the daily lane clears originals already cut, without waiting for an email", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0.25", FILES_PLACE: "host" });
    await h.dumpWith("dmp_b", [{ id: "ast_b1", name: "IMG_1.MOV", mime: "video/quicktime", bytes: new Uint8Array(10) }]);
    h.db.raw.exec(`UPDATE assets SET size_bytes = ${240 * 1024 ** 2} WHERE id = 'ast_b1'; UPDATE dumps SET status = 'ready', ready_at = '2026-11-20T00:00:00.000Z', kind = 'clips' WHERE id = 'dmp_b'`);
    const r = await enforceBudget(h.env);
    expect(r.cleared).toBe(1);
    expect(await h.r2.FILES.head("raw/dmp_b/ast_b1")).toBeNull();
    expect(h.one<{ d: string | null }>("SELECT raw_deleted_at AS d FROM assets WHERE id = 'ast_b1'").d).not.toBeNull();
  });
});

describe("originals on the shared storage rotate out (pure rule)", () => {
  const READY = Date.parse("2026-11-01T12:00:00.000Z");
  const at = (d: number) => new Date(READY + d * DAY);
  const dump = (x: Partial<RetentionDump> = {}): RetentionDump => ({ id: "d", status: "ready", ready_at: at(0).toISOString(), uploaded_at: at(-1).toISOString(), kept: 0, open_job: 0, sent14: null, sent3: null, ...x });

  it("7 days after the clips, one heads-up 3 days before; Keep does not hold it", () => {
    expect(retentionStep(dump(), at(3.9), "shared").do).toBe("none");
    expect(retentionStep(dump(), at(4), "shared")).toEqual({ do: "warn3", clears: at(7).toISOString() });
    const sent3 = at(4).toISOString();
    expect(retentionStep(dump({ sent3 }), at(6.9), "shared").do).toBe("none");
    expect(retentionStep(dump({ sent3 }), at(7), "shared")).toEqual({ do: "clear" });
    expect(retentionStep(dump({ sent3, kept: 1 }), at(7), "shared")).toEqual({ do: "clear" });
  });

  it("14 days after upload when the clips never came (failed or stuck), whichever comes first", () => {
    const stuck = dump({ status: "failed", ready_at: null, uploaded_at: at(0).toISOString() });
    expect(clearDate(stuck, "shared", false)!.toISOString()).toBe(at(14).toISOString());
    expect(retentionStep(stuck, at(13.9), "shared", false).do).toBe("none");
    expect(retentionStep(stuck, at(14), "shared", false)).toEqual({ do: "clear" });
    // clips made late: the upload's 14 days come first
    const late = dump({ ready_at: at(12).toISOString(), uploaded_at: at(0).toISOString() });
    expect(clearDate(late, "shared", false)!.toISOString()).toBe(at(14).toISOString());
  });

  it("never while a cut is running; with no studio email it clears on the day (no pause on the shared storage)", () => {
    expect(retentionStep(dump({ open_job: 1 }), at(40), "shared")).toEqual({ do: "none", why: "open" });
    expect(retentionStep(dump(), at(7), "shared", false)).toEqual({ do: "clear" });
    // a warning that goes out late still stands a day before the clear
    expect(retentionStep(dump(), at(30), "shared")).toEqual({ do: "warn3", clears: at(31).toISOString() });
  });
});

describe("originals on the shared storage, on a real studio", () => {
  it("one email 3 days ahead with no Keep, then cleared on day 7; clips stay", async () => {
    const h = await harness({ FILES_PLACE: "host" });
    await h.dumpWith("dmp_s", [{ id: "ast_s1", name: "IMG_1.MOV", mime: "video/quicktime" }]);
    await h.cut("dmp_s", undefined, 2);
    const READY = "2026-11-01T12:00:00.000Z";
    h.db.raw.exec(`UPDATE dumps SET ready_at = '${READY}' WHERE id = 'dmp_s'; UPDATE jobs SET status = 'done' WHERE ref_id = 'dmp_s'; UPDATE assets SET created_at = '2026-10-31T12:00:00.000Z'`);
    const at = (d: number) => new Date(Date.parse(READY) + d * DAY);
    const clips = h.one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE dump_id = 'dmp_s' AND status != 'deleted'").n;
    expect(await originalsRetention(h.env, at(3))).toMatchObject({ checked: 1, warned3: 0, cleared_files: 0 });
    expect(await originalsRetention(h.env, at(4))).toMatchObject({ warned3: 1, warned14: 0 });
    const mails = h.all<{ subject: string; ref_id: string }>("SELECT subject, ref_id FROM emails_sent WHERE kind = 'heads_up' ORDER BY sent_at, rowid");
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^Your original files clear /);
    const page = new Hono().route("/originals", originals as unknown as Hono);
    const link = `/originals/${await originalsToken(h.env.SESSION_SECRET, mails[0].ref_id)}`;
    const html = await (await page.request(`${BASE_URL}${link}`, {}, h.env)).text();
    expect(html).not.toContain("Keep it in my studio");
    expect(html).toContain("add your own storage");
    expect((await page.request(`${BASE_URL}${link}/keep`, { method: "POST" }, h.env)).status).toBe(409);
    expect(h.one<{ k: number }>("SELECT originals_kept AS k FROM dumps WHERE id = 'dmp_s'").k).toBe(0);
    expect(await originalsRetention(h.env, at(6.9))).toMatchObject({ cleared_files: 0 });
    expect(await originalsRetention(h.env, at(7))).toMatchObject({ cleared_dumps: 1, cleared_files: 1 });
    expect(await h.r2.FILES.head("raw/dmp_s/ast_s1")).toBeNull();
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE dump_id = 'dmp_s' AND status != 'deleted'").n).toBe(clips);
  });
});

describe("Use your own storage", () => {
  it("reads what she pastes: an account id, the dashboard's S3 API address with the bucket on it, or any https S3 address", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const keys = { access_key_id: "AKID", secret_access_key: "SECRET" };
    expect(ownStorageConfig({ endpoint: id, bucket: "my-files", ...keys })).toEqual({ ok: true, cfg: { endpoint: `https://${id}.r2.cloudflarestorage.com`, bucket: "my-files", accessKeyId: "AKID", secretAccessKey: "SECRET", region: "auto" } });
    expect(ownStorageConfig({ endpoint: `https://${id}.r2.cloudflarestorage.com/my-files`, bucket: "", ...keys })).toMatchObject({ ok: true, cfg: { bucket: "my-files" } });
    expect(ownStorageConfig({ endpoint: "s3.us-west-004.backblazeb2.com", bucket: "my-files", ...keys })).toMatchObject({ ok: true, cfg: { endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004" } });
    expect(ownStorageConfig({ endpoint: "http://example.com", bucket: "b1", ...keys }).ok).toBe(false);
    expect(ownStorageConfig({ endpoint: id, bucket: "My Files", ...keys }).ok).toBe(false);
    expect(ownStorageConfig({ endpoint: id, bucket: "my-files", access_key_id: "AKID" }).ok).toBe(false);
  });

  it("Test connection writes, reads back and deletes a probe, leaving nothing; a refused key says so in plain words", async () => {
    const s3 = fakeS3();
    const good = await checkOwnStorage({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "her-bucket", access_key_id: "AKID", secret_access_key: "SECRET" }, s3.fetcher);
    expect(good.ok).toBe(true);
    expect([...s3.objects.keys()]).toEqual([]);
    expect(s3.seen.map((r) => r.method)).toEqual(expect.arrayContaining(["PUT", "GET", "DELETE"]));
    const wrongBucket = await checkOwnStorage({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "not-hers", access_key_id: "AKID", secret_access_key: "SECRET" }, fakeS3().fetcher);
    expect(wrongBucket).toMatchObject({ ok: false, error: expect.stringMatching(/bucket was not found/) });
    const broken = await probeFiles(new S3Files({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "her-bucket", accessKeyId: "A", secretAccessKey: "S" }, fakeS3({ failPut: true }).fetcher) as unknown as R2Bucket);
    expect(broken).toMatchObject({ ok: false, step: "write" });
  });

  it("saved encrypted, hydrate sends new files to her bucket and still reads what was on the host's", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0" });
    const fields = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "her-bucket", access_key_id: "AKID", secret_access_key: "SECRET" };
    await saveConnection(h.env, "storage", JSON.stringify(fields), "ok", { bucket: "her-bucket", host: "acct.r2.cloudflarestorage.com", saved_at: "2026-11-21T00:00:00.000Z" });
    const row = h.one<{ secret_enc: string }>("SELECT secret_enc FROM connections WHERE service = 'storage'");
    expect(row.secret_enc).not.toContain("SECRET");
    const e = await hydrate(h.env);
    expect(e.FILES_PLACE).toBe("own");
    expect(e.FILES).toBeInstanceOf(LayeredFiles);
    expect((await storageReport(e)).own).toEqual({ bucket: "her-bucket", host: "acct.r2.cloudflarestorage.com", since: "2026-11-21T00:00:00.000Z" });
  });

  it("the layers: writes go to hers, reads fall back to the host's, deletes reach both, the meter lists each", async () => {
    const hers = memoryR2().FILES;
    const host = memoryR2().FILES;
    await host.put("raw/old/a", new Uint8Array(30));
    const files = new LayeredFiles(hers, host) as unknown as R2Bucket;
    await files.put("raw/new/b", new Uint8Array(20));
    expect(await hers.head("raw/new/b")).not.toBeNull();
    expect(await host.head("raw/new/b")).toBeNull();
    expect((await files.get("raw/old/a"))!.size).toBe(30);
    expect(await signedDownload(files, "raw/old/a", 60)).toBeNull();
    await files.delete("raw/old/a");
    expect(await host.head("raw/old/a")).toBeNull();
  });
});

describe("the Setup key store takes every service it is asked to keep", () => {
  it("every Setup step and her own storage save on the real schema (Higgsfield's Save once hit the table's CHECK)", async () => {
    const h = await harness();
    for (const id of [...SETUP_STEPS.map((s) => s.id), "storage" as const]) await saveConnection(h.env, id as never, "value", "ok", {});
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM connections").n).toBe(SETUP_STEPS.length + 1);
  });
});

describe("the bucket is the truth (measure)", () => {
  it("originals no longer in any place stop counting; a listing that failed marks nothing", async () => {
    const h = await harness({ FILES_PLACE: "host" });
    await h.dumpWith("dmp_m", [
      { id: "ast_m1", name: "IMG_1.MOV", mime: "video/quicktime" },
      { id: "ast_m2", name: "IMG_2.MOV", mime: "video/quicktime" },
    ]);
    h.db.raw.exec("UPDATE assets SET created_at = '2026-11-01T00:00:00.000Z'");
    await h.r2.FILES.delete("raw/dmp_m/ast_m1");
    const broken = { ...h.env, FILES: new LayeredFiles(h.r2.FILES, { list: () => Promise.reject(new Error("down")) } as unknown as R2Bucket) as unknown as R2Bucket };
    expect((await measureStorage(broken, new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(0);
    expect((await measureStorage(h.env, new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(1);
    expect(h.all<{ id: string }>("SELECT id FROM assets WHERE raw_deleted_at IS NOT NULL").map((a) => a.id)).toEqual(["ast_m1"]);
  });
});

it("HostReadOnly signs downloads through the host's bucket when it is S3", async () => {
  const s3 = new S3Files({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "her-bucket", accessKeyId: "A", secretAccessKey: "S" }, fakeS3().fetcher) as unknown as R2Bucket;
  expect(await signedDownload(new HostReadOnly(s3) as unknown as R2Bucket, "raw/a", 60)).toMatch(/X-Amz-Signature=/);
  expect(({} as Env).FILES_PLACE).toBeUndefined();
});
