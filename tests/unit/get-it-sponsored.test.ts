// Get it sponsored (owner-approved mock-up, 23 Oct 2026). Pins: the medical rules box and the dated
// to-do plan are code; a business studio reads "Get an event sponsored" (never "dream trips"); the
// job's result passes a gate (public proof or the brand is dropped, public business contacts only,
// off-limits dropped); "Pitch this brand" opens a deal with a DRAFT email that nothing sends; it is
// a page inside Brand deals, not a menu item; and 0036 keeps every jobs row.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { MEDICAL_RULES, isMedical, pitchBy, sponsorWords, todoPlan, EXAMPLE_CHIPS } from "@shared/sponsored";
import { cleanSponsorResult, sponsorJob, type SponsorSpec } from "@worker/jobs/sponsor";
import { JOB_HANDLERS } from "@worker/jobs/registry";
import { sponsored as sponsoredRoute, pitchIdea } from "@worker/routes/sponsored";
import { deals as dealsRoute } from "@worker/routes/deals";
import { harness, BASE_URL } from "./helpers/studio-fix-env";
import { ownerCookie } from "./helpers/owner-session";

const ROOT = path.resolve(__dirname, "..", "..");

describe("words and rules in code", () => {
  it("a business studio reads 'Get an event sponsored'; a creator 'Get an experience sponsored'; never 'dream'", () => {
    expect(sponsorWords("event").cta).toBe("Get an event sponsored");
    expect(sponsorWords("experience").cta).toBe("Get an experience sponsored");
    const all = JSON.stringify([sponsorWords("event"), sponsorWords("experience"), EXAMPLE_CHIPS]) + readFileSync(path.join(ROOT, "app/pages/Sponsored.tsx"), "utf8") + readFileSync(path.join(ROOT, "app/components/SponsorCard.tsx"), "utf8");
    expect(all).not.toMatch(/dream/i);
  });
  it("medical and cosmetic experiences are caught; a plain trip is not", () => {
    for (const t of ["Botox in NYC", "Korea skin clinic trip", "High-end medical tourism", "Lip filler at a med spa", "BBL in Miami", "Laser facial"]) expect(isMedical(t), t).toBe(true);
    for (const t of ["Spring break trip", "Hotel staycation", "Holiday open house", "Detox juice week"]) expect(isMedical(t), t).toBe(false);
  });
  it("the rules box carries the four required rules", () => {
    const rules = MEDICAL_RULES.join(" ");
    expect(rules).toMatch(/#ad/);
    expect(rules).toMatch(/FTC/);
    expect(rules).toMatch(/No medical claims/);
    expect(rules).toMatch(/licensed provider/i);
    expect(rules).toMatch(/platform's rules/);
  });
  it("to-do dates work back from the month, never before today", () => {
    const o = { whenMonth: "2027-03", today: "2026-10-23", medical: false, kind: "experience" as const, title: "Spring break trip" };
    expect(pitchBy(o)).toBe("2026-11-01"); // a trip: about 4 months ahead
    const plan = todoPlan(o);
    const by = Object.fromEntries(plan.map((t) => [t.id, t.by]));
    expect(by.pitch).toBe("2026-11-01");
    expect(by.follow).toBe("2026-11-15");
    expect(by.kit).toBe("2026-10-23"); // two weeks before the pitch is in the past: today
    expect(by.passports).toBe("2026-12-31");
    expect(plan.every((t) => !t.by || t.by >= "2026-10-23")).toBe(true);
    expect(plan.map((t) => t.id)).toEqual(expect.arrayContaining(["contract", "disclose", "ask"]));
    // dated lines first, in date order
    const dated = plan.filter((t) => t.by).map((t) => t.by!);
    expect(dated).toEqual([...dated].sort());
    const med = todoPlan({ ...o, whenMonth: "2026-12", medical: true, title: "Botox in NYC" });
    expect(med.map((t) => t.id)).toEqual(expect.arrayContaining(["consult", "licence", "consent"]));
    expect(med.find((t) => t.id === "pitch")!.by).toBe("2026-11-01"); // a treatment: a month ahead
    const ev = todoPlan({ ...o, kind: "event", title: "Holiday open house", whenMonth: "2026-12" });
    expect(ev.map((t) => t.id)).toEqual(expect.arrayContaining(["confirm", "after"]));
    expect(ev.find((t) => t.id === "pitch")!.by).toBe("2026-10-30"); // never sooner than a week out
  });
});

describe("the gate on the job's result", () => {
  const brand = { name: "Example Resort", website: "https://resort.example.com", fit: "best", proof: [{ text: "Creator program", url: "https://resort.example.com/creators" }] };
  it("no public proof → dropped; zero brands → null (she sees a clear failure)", () => {
    expect(cleanSponsorResult({ brands: [{ ...brand, proof: [] }], videos: [{ title: "a", hook: "b" }] })).toBeNull();
    expect(cleanSponsorResult({ brands: [{ ...brand, proof: [{ text: "x", url: "not a url" }] }] })).toBeNull();
    expect(cleanSponsorResult(null)).toBeNull();
  });
  it("a personal address is never a way in: 'Needs a way in'; a role address with its page is", () => {
    const r = cleanSponsorResult({ brands: [{ ...brand, wayIn: { kind: "email", value: "jane.doe@gmail.com", foundOn: "https://resort.example.com/c" } }, { ...brand, name: "B Co", wayIn: { kind: "email", value: "partnerships@b.example", foundOn: "https://b.example/c" } }, { ...brand, name: "C Co", wayIn: { kind: "email", value: "pr@c.example" } }] })!;
    expect(r.brands.map((b) => [b.name, b.wayIn.kind, b.wayIn.label])).toEqual([
      ["Example Resort", "none", "Needs a way in"],
      ["B Co", "email", "Public business email"],
      ["C Co", "none", "Needs a way in"], // no page it was printed on
    ]);
  });
  it("off-limits brands are dropped; no video ideas → the built-in three", () => {
    const r = cleanSponsorResult({ brands: [brand, { ...brand, name: "Vape Co", website: "https://vape.example.com" }] }, ["vape"], { title: "Spring break trip", kind: "experience" })!;
    expect(r.brands.map((b) => b.name)).toEqual(["Example Resort"]);
    expect(r.videos).toHaveLength(3);
    expect(r.videos[0].hook).toMatch(/spring break trip/);
  });
  it("is a registered job type with a workflow and a passing $0 self-test", () => {
    expect(JOB_HANDLERS.sponsor).toBe(sponsorJob);
    const y = readFileSync(path.join(ROOT, ".github/workflows/job-sponsor.yml"), "utf8");
    expect(y).toContain("types: [sponsor]");
    expect(y).toContain("secrets[format('JOB_SHARED_SECRET_{0}', github.event.client_payload.studio)]");
    expect(y).not.toMatch(/OPENROUTER_API_KEY: \$\{\{ secrets\./);
    const out = execFileSync("python3", [path.join(ROOT, "jobs", "sponsor.py"), "--selftest"], { encoding: "utf8" });
    expect(out).toContain('"sponsor.selftest", "ok": true');
    expect(readFileSync(path.join(ROOT, "jobs", "sponsor.py"), "utf8")).toMatch(/import ai as A/);
  });
});

async function studio(extra: Partial<Env> = {}) {
  const h = await harness(extra);
  h.db.raw.exec(`UPDATE brand_profile SET sections = '{"voice":"warm","who":"A creator","audience":"Women 25-40","themes":"Get ready with me","off_limits":"vape"}'`);
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("fake", fakeServices(c.env));
    c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
    await next();
  });
  app.route("/api/sponsored", sponsoredRoute);
  app.route("/api/deals", dealsRoute);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await app.request(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(h.env) }, body: body === undefined ? undefined : JSON.stringify(body) }, h.env);
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { ...h, call };
}

describe("through the real schema", () => {
  it("ask → $0 job → ready → pitch into Deals as a draft she sends herself → Calendar → ticks kept on Run it again", async () => {
    const s = await studio();
    const made = await s.call("POST", "/api/sponsored", { title: "Botox in NYC", whenMonth: "2026-12", who: "Just me" });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const row = s.one<{ medical: number; status: string; job_id: string }>("SELECT medical, status, job_id FROM sponsor_asks WHERE id = ?", made.json.id);
    expect(row).toMatchObject({ medical: 1, status: "researching" });
    expect(s.one<{ type: string }>("SELECT type FROM jobs WHERE id = ?", row.job_id).type).toBe("sponsor");

    const spec = (await sponsorJob.buildSpec(s.env, row.job_id, made.json.id)) as SponsorSpec;
    expect(spec.ask).toMatchObject({ title: "Botox in NYC", when_label: "Dec 2026", medical: true });
    expect(spec.profile.audience).toBe("Women 25-40");
    expect(spec.profile.off_limits).toContain("vape");
    expect(Array.isArray(spec.numbers)).toBe(true);
    expect(spec.kind).toBe("experience");

    const waiting = await s.call("GET", `/api/sponsored/${made.json.id}`);
    expect(waiting.json.ask.status).toBe("researching");
    expect(waiting.json.rules).toEqual(MEDICAL_RULES); // known from her words alone, before any brand

    await sponsorJob.applyResult(s.env, row.job_id, made.json.id, await sponsorJob.fakeRun!(s.env, row.job_id, made.json.id, {}));
    const ready = await s.call("GET", `/api/sponsored/${made.json.id}`);
    expect(ready.json.ask.status).toBe("ready");
    expect(ready.json.rules.slice(0, MEDICAL_RULES.length)).toEqual(MEDICAL_RULES);
    expect(ready.json.result.brands.map((b: { wayIn: { kind: string } }) => b.wayIn.kind)).toEqual(["email", "form", "none"]);
    expect(ready.json.plan.find((t: { id: string }) => t.id === "consult")).toBeTruthy();

    const key = ready.json.result.brands[0].key;
    const p = await s.call("POST", `/api/sponsored/${made.json.id}/brands/${key}/pitch`);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const deal = s.one<{ stage: string; terms: string }>("SELECT stage, terms FROM deals WHERE id = ?", p.json.dealId);
    expect(deal.stage).toBe("pitch"); // its public way in came with it
    expect(JSON.parse(deal.terms).idea).toMatch(/Example Hotel Co\. sponsoring my botox in NYC in Dec 2026/);
    expect(s.all("SELECT status FROM deal_emails WHERE deal_id = ?", p.json.dealId)).toEqual([{ status: "draft" }]);
    expect(s.one<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent").n).toBe(0); // nothing sends: she sends every pitch
    expect(s.all<{ kind: string; value: string }>("SELECT kind, value FROM brand_contacts").map((c) => c.kind)).toEqual(["role_email"]);
    // Twice is one deal.
    const again = await s.call("POST", `/api/sponsored/${made.json.id}/brands/${key}/pitch`);
    expect(again.json.dealId).toBe(p.json.dealId);
    expect(s.one<{ n: number }>("SELECT COUNT(*) AS n FROM deals").n).toBe(1);

    // "Needs a way in": still a deal, at Find contact.
    const third = await s.call("POST", `/api/sponsored/${made.json.id}/brands/${ready.json.result.brands[2].key}/pitch`);
    expect(third.json.needsWayIn).toBe(true);
    expect(s.one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?", third.json.dealId).stage).toBe("find_contact");

    await s.call("POST", `/api/sponsored/${made.json.id}/brands/${ready.json.result.brands[1].key}/hide`, { hidden: true });
    await s.call("POST", `/api/sponsored/${made.json.id}/ticks`, { id: "consult", done: true });
    const cal = await s.call("POST", `/api/sponsored/${made.json.id}/calendar`, { videoId: "v1", day: "2026-12-04" });
    expect(cal.status).toBe(200);
    const film = await s.call("GET", "/api/sponsored/film?from=2026-12-01&to=2026-12-07");
    expect(film.json.items).toHaveLength(1);
    expect(film.json.items[0].note).toMatch(/^Hook: /);
    expect(s.one<{ n: number }>("SELECT COUNT(*) AS n FROM posts").n).toBe(0); // a day to film, never a post

    const rerun = await s.call("POST", `/api/sponsored/${made.json.id}/run`);
    expect(rerun.status).toBe(200);
    const after = s.one<{ ticks: string; hidden: string; pitched: string; status: string }>("SELECT ticks, hidden, pitched, status FROM sponsor_asks WHERE id = ?", made.json.id);
    expect(after.status).toBe("researching");
    expect(Object.keys(JSON.parse(after.ticks))).toEqual(["consult"]);
    expect(JSON.parse(after.hidden)).toHaveLength(1);
    expect(Object.keys(JSON.parse(after.pitched))).toHaveLength(2);

    const list = await s.call("GET", "/api/sponsored");
    expect(list.json).toMatchObject({ kind: "experience", total: 1 });
    await s.call("POST", `/api/sponsored/${made.json.id}/archive`, { archived: true });
    expect((await s.call("GET", "/api/sponsored")).json.total).toBe(0);
    expect((await s.call("GET", "/api/sponsored?archived=1")).json.total).toBe(1);
  });

  it("a failed job shows a clear failure and Try again starts it again", async () => {
    const s = await studio();
    const made = await s.call("POST", "/api/sponsored", { title: "Spring break trip" });
    const jobId = s.one<{ job_id: string }>("SELECT job_id FROM sponsor_asks WHERE id = ?", made.json.id).job_id;
    s.db.raw.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${jobId}'`);
    const got = await s.call("GET", `/api/sponsored/${made.json.id}`);
    expect(got.json.ask.status).toBe("failed");
    expect(got.json.ask.error).toMatch(/Try again/);
    expect((await s.call("POST", `/api/sponsored/${made.json.id}/run`)).status).toBe(200);
    expect(s.one<{ status: string }>("SELECT status FROM sponsor_asks WHERE id = ?", made.json.id).status).toBe("researching");
    // An empty result is a failure too, never a blank "ready".
    const job2 = s.one<{ job_id: string }>("SELECT job_id FROM sponsor_asks WHERE id = ?", made.json.id).job_id;
    await sponsorJob.applyResult(s.env, job2, made.json.id, { brands: [] });
    expect(s.one<{ status: string }>("SELECT status FROM sponsor_asks WHERE id = ?", made.json.id).status).toBe("failed");
    expect((await s.call("POST", "/api/sponsored", { title: "x" })).status).toBe(400);
  });

  it("a business studio's list says event", async () => {
    const s = await studio({ SPONSOR_KIND: "event" });
    expect((await s.call("GET", "/api/sponsored")).json.kind).toBe("event");
  });

  it("the idea the first email leads with names the experience and the brand's video", () => {
    const r = cleanSponsorResult({ brands: [{ name: "Example Resort", proof: [{ text: "x", url: "https://r.example.com/c" }] }], videos: [{ title: "Hotel GRWM", hook: "h", forBrand: "Example Resort" }] })!;
    expect(pitchIdea({ title: "Spring break trip", when_month: "2027-03" }, r.brands[0], r)).toBe("Example Resort sponsoring my spring break trip in Mar 2027, filmed as “Hotel GRWM” and clearly labelled");
  });
});

describe("where it lives", () => {
  it("a card at the top of Brand deals, never a menu item; routed inside /deals", () => {
    const deals = readFileSync(path.join(ROOT, "app/pages/Deals.tsx"), "utf8");
    expect(deals.indexOf("<SponsorCard />")).toBeGreaterThan(0);
    expect(deals.indexOf("<SponsorCard />")).toBeLessThan(deals.indexOf('aria-label="Money"'));
    expect(readFileSync(path.join(ROOT, "app/components/Shell.tsx"), "utf8")).not.toMatch(/sponsor/i);
    const app = readFileSync(path.join(ROOT, "app/App.tsx"), "utf8");
    expect(app).toContain('<Route path="/deals/sponsored" element={<Sponsored />} />');
    expect(readFileSync(path.join(ROOT, "app/pages/Sponsored.tsx"), "utf8")).toContain("← Back to Brand deals");
  });
  it("Porch & Party (sample1) is the event studio; every other studio reads experience", () => {
    const w = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
    const cfg = JSON.parse(w.replace(/^\s*\/\/.*$/gm, "")) as { env: Record<string, { vars: Record<string, string> }> };
    const kinds = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, v.vars.SPONSOR_KIND]));
    expect(kinds.sample1).toBe("event");
    for (const slug of ["hadiyah", "mercedes", "sheila", "sample2", "sample3"]) expect(kinds[slug], slug).toBe("experience");
  });
  it("0036 rebuilds jobs keeping every row and adds 'sponsor'", () => {
    const db = new DatabaseSync(":memory:");
    const dir = path.resolve(ROOT, "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0036")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    db.exec("INSERT INTO jobs (id, type, status, nonce, progress) VALUES ('job_a', 'cut', 'done', 'n1', '{}'), ('job_b', 'pastvideos', 'failed', 'n2', NULL)");
    for (const f of files.filter((x) => x >= "0036")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    expect(db.prepare("SELECT id, type, status, nonce, progress FROM jobs ORDER BY id").all()).toEqual([
      { id: "job_a", type: "cut", status: "done", nonce: "n1", progress: "{}" },
      { id: "job_b", type: "pastvideos", status: "failed", nonce: "n2", progress: null },
    ]);
    db.exec("INSERT INTO jobs (id, type, nonce) VALUES ('job_c', 'sponsor', 'n3')");
  });
});
