// engine/sources.mjs on a local fake Worker (no secret, no network): the plan and its pictures land in
// the places the plan names, changed bytes are refused, a bad signature is refused, an empty plan stops.
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchPlan, srcKeyFor } from "./sources.mjs";

const SECRET = "selftest-secret";
const store = new Map();
const pic = Buffer.from("a real picture's bytes");
const sha = createHash("sha256").update(pic).digest("hex");
const put = (plan) => {
  store.set("engine-src/test-plan/plan.json", Buffer.from(JSON.stringify(plan)));
  store.set(srcKeyFor("test-plan", "real:job/one.jpg"), pic);
};
const server = createServer((req, res) => {
  const key = decodeURIComponent(req.url.replace(/^\/api\/ops\/engine-src-file\//, ""));
  const ts = req.headers["x-ops-timestamp"];
  const want = createHmac("sha256", SECRET).update(`${ts}.ops:get:${key}`).digest("hex");
  if (req.headers["x-ops-signature"] !== want) { res.writeHead(401); return res.end(); }
  if (!store.has(key)) { res.writeHead(404); return res.end(); }
  res.writeHead(200);
  res.end(store.get(key));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const home = mkdtempSync(path.join(os.tmpdir(), "engine-home-"));
const plansDir = path.join(home, "plans");
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok" : "FAIL"} ${what}`); if (!ok) failed++; };
const plan = { studio: "sample1", sources: { real: "~/Work/real" }, pieces: [{ id: "p1", pics: [{ src: "real:job/one.jpg" }] }], source_sha: { "real:job/one.jpg": sha } };

put(plan);
const r = await fetchPlan("test-plan", { base, secret: SECRET, home, plansDir });
check(r.pictures === 1 && readFileSync(path.join(home, "Work/real/job/one.jpg")).equals(pic), "the picture lands where the plan names it");
check(existsSync(path.join(plansDir, "test-plan.json")), "the plan lands in plans/");

put({ ...plan, source_sha: { "real:job/one.jpg": "0".repeat(64) } });
check(await fetchPlan("test-plan", { base, secret: SECRET, home, plansDir }).then(() => false, (e) => /SOURCE_CHANGED/.test(e.message)), "changed bytes are a NAMED STOP");

put(plan);
check(await fetchPlan("test-plan", { base, secret: "wrong", home, plansDir }).then(() => false, (e) => /401/.test(e.message)), "a wrong secret is refused");

put({ ...plan, pieces: [{ id: "p1", pics: [] }] });
check(await fetchPlan("test-plan", { base, secret: SECRET, home, plansDir }).then(() => false, (e) => /NO_SOURCES/.test(e.message)), "a plan with no picture stops");

put({ ...plan, sources: { real: "/etc" } });
check(await fetchPlan("test-plan", { base, secret: SECRET, home, plansDir }).then(() => false, (e) => /SOURCE_OUTSIDE_HOME/.test(e.message)), "a folder outside home is refused");

server.close();
if (failed) { console.log(`NAMED STOP [SELFTEST_FAILED] ${failed}`); process.exit(1); }
console.log("OUTPUT 5 checks passed");
