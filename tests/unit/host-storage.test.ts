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
import { mayClear, OWN_STORAGE_NEEDED_WORDS, OwnStorageNeeded, ownStorageConfig, probeFiles, S3Files, signedDownload, StudioFiles } from "@worker/services/s3files";
import { archive } from "@worker/routes/archive";
import { readFileSync as readSql } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { UPLOAD_PART_SIZE } from "@shared/constants";
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
    expect(e.FILES).toBeInstanceOf(StudioFiles);
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
  });

  it("the heads-up always stands its full 3 days: one that went late moves the clear, never a 1-day warning", () => {
    const late = at(6).toISOString();
    expect(clearDate(dump({ sent3: late }), "shared")!.toISOString()).toBe(at(9).toISOString());
    expect(retentionStep(dump({ sent3: late }), at(8.9), "shared").do).toBe("none");
    expect(retentionStep(dump({ sent3: late }), at(9), "shared")).toEqual({ do: "clear" });
    expect(retentionStep(dump(), at(30), "shared")).toEqual({ do: "warn3", clears: at(33).toISOString() });
  });

  it("a dump she kept before this rule: cleared only after the heads-up stood 3 days; with no email never, it stays", () => {
    expect(retentionStep(dump({ kept: 1 }), at(40), "shared")).toEqual({ do: "warn3", clears: at(43).toISOString() });
    expect(retentionStep(dump({ kept: 1, sent3: at(40).toISOString() }), at(42.9), "shared").do).toBe("none");
    expect(retentionStep(dump({ kept: 1, sent3: at(40).toISOString() }), at(43), "shared")).toEqual({ do: "clear" });
    expect(retentionStep(dump({ kept: 1 }), at(400), "shared", false)).toEqual({ do: "none", why: "kept_no_email" });
    expect(clearDate(dump({ kept: 1 }), "shared", false)).toBeNull();
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
    // only Cloudflare R2 and the known S3 services: never an address the Worker would sign to anywhere else
    for (const bad of ["https://example.com", "https://169.254.169.254", "https://localhost", "https://r2.cloudflarestorage.com.evil.example", "https://evil.example/0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"]) expect(ownStorageConfig({ endpoint: bad, bucket: "my-files", ...keys }).ok, bad).toBe(false);
    for (const good of ["https://s3.us-east-1.amazonaws.com", "https://s3.amazonaws.com", "https://s3.eu-central-1.wasabisys.com", `https://${id}.eu.r2.cloudflarestorage.com`]) expect(ownStorageConfig({ endpoint: good, bucket: "my-files", ...keys }).ok, good).toBe(true);
    expect(ownStorageConfig({ endpoint: id, bucket: "My Files", ...keys }).ok).toBe(false);
    expect(ownStorageConfig({ endpoint: id, bucket: "my-files", access_key_id: "AKID" }).ok).toBe(false);
  });

  it("Test connection writes, reads back and deletes a probe, leaving nothing; a refused key says so in plain words", async () => {
    const s3 = fakeS3();
    const good = await checkOwnStorage({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "her-bucket", access_key_id: "AKID", secret_access_key: "SECRET" }, s3.fetcher);
    expect(good.ok).toBe(true);
    expect([...s3.objects.keys()]).toEqual([]);
    expect(s3.seen.map((r) => r.method)).toEqual(expect.arrayContaining(["PUT", "GET", "DELETE"]));
    const wrongBucket = await checkOwnStorage({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "not-hers", access_key_id: "AKID", secret_access_key: "SECRET" }, fakeS3().fetcher);
    expect(wrongBucket).toMatchObject({ ok: false, error: expect.stringMatching(/bucket was not found/) });
    // a redirect is never followed: the signed request goes only to the address she saved
    const redirecting = (async () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/" } })) as typeof fetch;
    const seenInit: RequestInit[] = [];
    const watch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenInit.push({ redirect: (input instanceof Request ? input.redirect : init?.redirect) as RequestInit["redirect"] });
      return redirecting(input, init);
    }) as typeof fetch;
    expect(await checkOwnStorage({ endpoint: "0123456789abcdef0123456789abcdef", bucket: "her-bucket", access_key_id: "A", secret_access_key: "S" }, watch)).toMatchObject({ ok: false });
    expect(seenInit[0].redirect).toBe("manual");
    const broken = await probeFiles(new S3Files({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "her-bucket", accessKeyId: "A", secretAccessKey: "S" }, fakeS3({ failPut: true }).fetcher) as unknown as R2Bucket);
    expect(broken).toMatchObject({ ok: false, step: "write" });
  });

  it("saved encrypted, hydrate sends new files to her bucket and still reads what was on the host's", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0" });
    const fields = { endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "her-bucket", access_key_id: "AKID", secret_access_key: "SECRET" };
    await saveConnection(h.env, "storage", JSON.stringify({ current: fields, previous: [] }), "ok", { bucket: "her-bucket", host: "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", saved_at: "2026-11-21T00:00:00.000Z" });
    const row = h.one<{ secret_enc: string }>("SELECT secret_enc FROM connections WHERE service = 'storage'");
    expect(row.secret_enc).not.toContain("SECRET");
    const e = await hydrate(h.env);
    expect(e.FILES_PLACE).toBe("own");
    expect(e.FILES).toBeInstanceOf(StudioFiles);
    expect((await storageReport(e)).own).toEqual({ bucket: "her-bucket", host: "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", since: "2026-11-21T00:00:00.000Z" });
  });

  it("the layers: writes go to hers, reads fall back to the host's, deletes reach both, the meter lists each", async () => {
    const hers = memoryR2().FILES;
    const host = memoryR2().FILES;
    await host.put("raw/old/a", new Uint8Array(30));
    const files = new StudioFiles({ write: hers, own: true, host, readOnly: [] }) as unknown as R2Bucket;
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
    const broken = { ...h.env, FILES: new StudioFiles({ write: { list: () => Promise.reject(new Error("down")) } as unknown as R2Bucket, own: true, host: h.r2.FILES, readOnly: [] }) as unknown as R2Bucket };
    expect((await measureStorage(broken, new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(0);
    expect((await measureStorage(h.env, new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(1);
    expect(h.all<{ id: string }>("SELECT id FROM assets WHERE raw_deleted_at IS NOT NULL").map((a) => a.id)).toEqual(["ast_m1"]);
  });
});

it("with nowhere to write, downloads are still signed through the host's bucket when it is S3", async () => {
  const fake = fakeS3();
  const s3 = new S3Files({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "her-bucket", accessKeyId: "A", secretAccessKey: "S" }, fake.fetcher) as unknown as R2Bucket;
  await s3.put("raw/a", "x");
  expect(await signedDownload(new StudioFiles({ write: null, own: false, host: s3, readOnly: [] }) as unknown as R2Bucket, "raw/a", 60)).toMatch(/X-Amz-Signature=/);
  expect(({} as Env).FILES_PLACE).toBeUndefined();
});

// ---------------------------------------------------------------- review round 1 (21 Nov 2026)

import { vi, afterEach } from "vitest";
import { ownerCookie } from "./helpers/owner-session";
import { countNewFile, jobOutputRefusal, storageHealth, enforceBudget as budget } from "@worker/lib/storage";
import { decryptSecret } from "@worker/lib/crypto";
import { partRefusal, readUploadTicket, uploadTicket } from "@worker/routes/uploads";

afterEach(() => vi.unstubAllGlobals());

describe("the share cannot be beaten by the upload itself", () => {
  const begin = async (h: Awaited<ReturnType<typeof harness>>, size: number) => {
    h.db.raw.exec("INSERT OR IGNORE INTO dumps (id, door, notes, status) VALUES ('dmp_u', 'new', '', 'uploading')");
    const s = await h.call("POST", "/api/uploads/start", { kind: "video", parentId: "dmp_u", fileName: "IMG.MOV", size, mimeType: "video/quicktime" });
    expect(s.status).toBe(200);
    return s.json as { id: string; key: string; uploadId: string; ticket: string };
  };
  const put = (h: Awaited<ReturnType<typeof harness>>, u: { id: string; key: string; uploadId: string }, n: number, body: Uint8Array, ticket: string, headers: Record<string, string> = {}) =>
    h.request("PUT", `/api/uploads/${u.id}/parts/${n}?key=${encodeURIComponent(u.key)}&uploadId=${encodeURIComponent(u.uploadId)}&ticket=${encodeURIComponent(ticket)}`, body, { "content-type": "application/octet-stream", ...headers });

  it("a part past the declared size, a part bigger than a part, or a ticket not signed for it is refused", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0.25", FILES_PLACE: "host" });
    const u = await begin(h, 50);
    expect((await put(h, u, 2, new Uint8Array(10), u.ticket)).status).toBe(413);
    expect((await put(h, u, 1, new Uint8Array(10), u.ticket, { "content-length": String(UPLOAD_PART_SIZE + 1) })).status).toBe(413);
    const forged = `${10 * GB}.${u.ticket.split(".")[1]}`;
    expect((await put(h, u, 1, new Uint8Array(10), forged)).status).toBe(409);
    expect((await put(h, u, 1, new Uint8Array(10), "")).status).toBe(409);
    expect((await put(h, u, 1, new Uint8Array(10), u.ticket)).status).toBe(200);
    // pure: the job route has no declared size, but its pieces are held to the part size too
    expect(partRefusal(9999, null, String(UPLOAD_PART_SIZE))).toBeNull();
    expect(partRefusal(1, null, String(UPLOAD_PART_SIZE + 1))).not.toBeNull();
    expect(partRefusal(1, null, undefined)).not.toBeNull();
    expect(await readUploadTicket("s", "k", "u", await uploadTicket("s", "k", "u", 5))).toBe(5);
    expect(await readUploadTicket("s", "k", "other", await uploadTicket("s", "k", "u", 5))).toBeNull();
  });

  it("a file that comes out bigger than declared is deleted and refused, and its row never counts as uploaded", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0.25", FILES_PLACE: "host" });
    const u = await begin(h, 50);
    const part = await put(h, u, 1, new Uint8Array(100), u.ticket);
    expect(part.status).toBe(200);
    const done = await h.call("POST", `/api/uploads/${u.id}/complete`, { key: u.key, uploadId: u.uploadId, ticket: u.ticket, parts: [await part.json()] });
    expect(done.status).toBe(409);
    expect(await h.r2.FILES.head(u.key)).toBeNull();
    expect(h.one<{ s: string }>("SELECT upload_status AS s FROM assets WHERE id = ?", u.id).s).toBe("aborted");
  });

  it("job outputs and clips count against the share at once, and a job may not start writing once it is full", async () => {
    const h = await harness({ HOST_STORAGE_GB: "0.25", FILES_PLACE: "host" });
    const before = (await storageReport(h.env)).used_bytes;
    await countNewFile(h.env, 100 * 1024 ** 2);
    expect((await storageReport(h.env)).used_bytes).toBe(before + 100 * 1024 ** 2);
    expect(await jobOutputRefusal(h.env)).toBeNull();
    await countNewFile(h.env, 200 * 1024 ** 2);
    expect(await jobOutputRefusal(h.env)).toMatch(/^SHARE_FULL/);
    expect(await jobOutputRefusal({ ...h.env, FILES_PLACE: "own" })).toBeNull();
    // and a browser upload that is not an original counts the same way
    expect((await uploadRefusal(h.env, 1)) !== null).toBe(true);
  });
});

describe("kept originals on the shared storage, on a real studio", () => {
  const kept = async (extra = {}) => {
    const h = await harness({ FILES_PLACE: "host", ...extra });
    await h.dumpWith("dmp_k", [{ id: "ast_k1", name: "IMG_1.MOV", mime: "video/quicktime" }]);
    h.db.raw.exec("UPDATE dumps SET status = 'ready', kind = 'clips', ready_at = '2026-10-01T00:00:00.000Z', originals_kept = 1 WHERE id = 'dmp_k'; UPDATE assets SET created_at = '2026-09-30T00:00:00.000Z'");
    return h;
  };
  const day = (d: number) => new Date(Date.parse("2026-11-22T12:00:00.000Z") + d * DAY);

  it("with studio email: the heads-up first, cleared only after its full 3 days", async () => {
    const h = await kept();
    expect(await originalsRetention(h.env, day(0))).toMatchObject({ warned3: 1, cleared_files: 0 });
    expect(await originalsRetention(h.env, day(2.9))).toMatchObject({ cleared_files: 0 });
    expect(await h.r2.FILES.head("raw/dmp_k/ast_k1")).not.toBeNull();
    expect(await originalsRetention(h.env, day(3))).toMatchObject({ cleared_files: 1 });
  });

  it("with no studio email: never cleared, by the rule or the budget, and the Storage light says so", async () => {
    const h = await kept({ FAKE_SERVICES: "0", PRACTICE: ["resend"], HOST_STORAGE_GB: "0.25" });
    h.db.raw.exec(`UPDATE assets SET size_bytes = ${250 * 1024 ** 2}`);
    expect(await originalsRetention(h.env, day(400))).toMatchObject({ cleared_files: 0, kept_waiting: 1 });
    expect((await budget(h.env, day(400))).cleared).toBe(0);
    expect(await h.r2.FILES.head("raw/dmp_k/ast_k1")).not.toBeNull();
    // the meter is over 90% here, so the light is red; with room it is the yellow "kept" note
    h.db.raw.exec("UPDATE assets SET size_bytes = 1");
    await storageHealth(h.env);
    expect(h.one<{ light: string; note: string; fix_guide: string }>("SELECT light, note, fix_guide FROM health WHERE name = 'Storage'")).toMatchObject({ light: "yellow", fix_guide: "setup-email", note: expect.stringMatching(/1 upload you kept stays/) });
  });
});

describe("her own bucket stays safe", () => {
  it("only the studio's folders (raw/, clips/) are counted or deleted in her bucket; a bucket she used before is never written or deleted", async () => {
    const hers = memoryR2().FILES;
    const old = memoryR2().FILES;
    const host = memoryR2().FILES;
    await hers.put("photos/her-wedding.jpg", new Uint8Array(500));
    await hers.put("raw/d/a", new Uint8Array(10));
    await old.put("raw/d/before", new Uint8Array(20));
    const files = new StudioFiles({ write: hers, own: true, host, readOnly: [old] }) as unknown as R2Bucket;
    await files.delete(["photos/her-wedding.jpg", "raw/d/before"]);
    expect(await hers.head("photos/her-wedding.jpg")).not.toBeNull();
    expect(await old.head("raw/d/before")).not.toBeNull();
    expect((await files.get("raw/d/before"))!.size).toBe(20);
    expect(await mayClear(files, "raw/d/before")).toBe(false);
    expect(await mayClear(files, "raw/d/a")).toBe(true);
    const h = await harness({ FILES_PLACE: "own" });
    const r = await measureStorage({ ...h.env, FILES: files });
    expect(r.listed).toBe(10 + 20);
  });

  it("an original that lives only in a bucket she used before is never cleared or marked gone", async () => {
    const h = await harness({ FILES_PLACE: "host" });
    const old = memoryR2().FILES;
    await h.dumpWith("dmp_o", [{ id: "ast_o1", name: "IMG_1.MOV", mime: "video/quicktime" }]);
    await old.put("raw/dmp_o/ast_o1", new Uint8Array(100));
    await h.r2.FILES.delete("raw/dmp_o/ast_o1");
    h.db.raw.exec("UPDATE dumps SET status = 'ready', kind = 'clips', ready_at = '2026-10-01T00:00:00.000Z' WHERE id = 'dmp_o'; UPDATE assets SET created_at = '2026-09-30T00:00:00.000Z'; INSERT INTO file_notices (dump_id, stage, batch_id, sent_at) VALUES ('dmp_o', '3', 'fnb_cccccccc', '2026-10-02T00:00:00.000Z')");
    const env = { ...h.env, FILES: new StudioFiles({ write: h.r2.FILES, own: false, host: h.r2.FILES, readOnly: [old] }) as unknown as R2Bucket };
    expect(await originalsRetention(env, new Date("2026-11-22T00:00:00.000Z"))).toMatchObject({ cleared_files: 0, held_files: 1 });
    expect((await measureStorage(env, new Date("2026-11-22T00:00:00.000Z"))).gone).toBe(0);
    expect(h.one<{ d: string | null }>("SELECT raw_deleted_at AS d FROM assets WHERE id = 'ast_o1'").d).toBeNull();
  });

  it("storage settings that cannot be read are 'unknown': nothing is marked gone, and the light asks her to save them again", async () => {
    const h = await harness({ HOST_STORAGE_GB: "1" });
    await h.dumpWith("dmp_x", [{ id: "ast_x1", name: "IMG_1.MOV", mime: "video/quicktime" }]);
    h.db.raw.exec("UPDATE assets SET created_at = '2026-11-01T00:00:00.000Z'");
    await h.r2.FILES.delete("raw/dmp_x/ast_x1");
    h.db.raw.prepare("INSERT INTO connections (service, status, secret_enc, meta) VALUES ('storage', 'ok', 'not-a-cipher', '{}')").run();
    const e = await hydrate(h.env);
    expect(e.FILES_UNSURE).toBe("1");
    expect((await measureStorage(e, new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(0);
    await storageHealth(e);
    expect(h.one<{ fix_guide: string }>("SELECT fix_guide FROM health WHERE name = 'Storage'").fix_guide).toBe("own-storage");
    // negative proof: readable settings and the same missing file is marked gone
    expect((await measureStorage(await hydrate({ ...h.env, DB: h.env.DB }), new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(0);
    h.db.raw.exec("DELETE FROM connections WHERE service = 'storage'");
    expect((await measureStorage(await hydrate(h.env), new Date("2026-11-21T00:00:00.000Z"))).gone).toBe(1);
  });

  it("switching or removing her storage keeps the old buckets readable (Settings → Storage, through the real routes)", async () => {
    const fake = fakeS3();
    vi.stubGlobal("fetch", fake.fetcher);
    const h = await harness({ HOST_STORAGE_GB: "1" });
    const app = new Hono().route("/api/archive", archive as unknown as Hono);
    const call = async (p: string, body?: unknown) => app.request(`${BASE_URL}${p}`, { method: "POST", headers: { "content-type": "application/json", cookie: await ownerCookie(h.env) }, body: body === undefined ? undefined : JSON.stringify(body) }, h.env);
    const a = { endpoint: "0123456789abcdef0123456789abcdef", bucket: "her-bucket", access_key_id: "A1", secret_access_key: "S1" };
    const b = { endpoint: "fedcba9876543210fedcba9876543210", bucket: "her-bucket", access_key_id: "A2", secret_access_key: "S2" };
    expect((await call("/api/archive/storage/own", a)).status).toBe(200);
    expect((await call("/api/archive/storage/own", b)).status).toBe(200);
    const saved = async () => JSON.parse(await decryptSecret(h.env.SECRETS_KEY, h.one<{ s: string }>("SELECT secret_enc AS s FROM connections WHERE service = 'storage'").s));
    expect((await saved()).current.access_key_id).toBe("A2");
    expect((await saved()).previous.map((p: { access_key_id: string }) => p.access_key_id)).toEqual(["A1"]);
    let e = await hydrate(h.env);
    expect(e.FILES_PLACE).toBe("own");
    expect((e.FILES as unknown as StudioFiles).o.readOnly).toHaveLength(1);
    expect((await call("/api/archive/storage/own/remove")).status).toBe(200);
    e = await hydrate(h.env);
    expect(e.FILES_PLACE).toBe("host");
    expect((e.FILES as unknown as StudioFiles).o.readOnly).toHaveLength(2);
    expect((await saved()).current).toBeNull();
    // Measure now is still there
    expect((await call("/api/archive/storage/measure")).status).toBe(200);
  });
});

describe("migration 0045 keeps every connection", () => {
  it("every row from before survives byte for byte, and storage and higgsfield save after", () => {
    const db = new DatabaseSync(":memory:");
    const dir = path.join(root, "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "0045")) db.exec(readSql(path.join(dir, f), "utf8"));
    const old = ["buffer", "openrouter", "firecrawl", "resend", "hunter", "meta", "google", "tiktok", "github", "elevenlabs", "opusclip", "vizard", "klap", "submagic", "descript", "youtube", "youtube_api", "google_app", "meta_app", "facebook", "pinterest", "huggingface"];
    const ins = db.prepare("INSERT INTO connections (service, status, secret_enc, meta, last_ok_at, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    old.forEach((s, i) => ins.run(s, i % 2 ? "ok" : "error", `enc-${s}`, `{"n":${i}}`, i % 3 ? null : "2026-11-01T00:00:00.000Z", i % 2 ? null : "refused", `2026-11-0${(i % 9) + 1}T00:00:00.000Z`));
    const before = db.prepare("SELECT * FROM connections ORDER BY service").all();
    for (const f of files.filter((f) => f >= "0045")) db.exec(readSql(path.join(dir, f), "utf8"));
    expect(db.prepare("SELECT * FROM connections ORDER BY service").all()).toEqual(before);
    ins.run("storage", "ok", "x", "{}", null, null, "2026-11-21T00:00:00.000Z");
    ins.run("higgsfield", "ok", "x", "{}", null, null, "2026-11-21T00:00:00.000Z");
    expect(() => ins.run("nonsense", "ok", "x", "{}", null, null, "2026-11-21T00:00:00.000Z")).toThrow(/CHECK/);
  });
});
