// Signs the shared ship-ready-baseline check in to the local studio (seq-bin, kind web-app).
// The same one-time-code login the e2e suite uses (tests/e2e/helpers.ts login): wrangler dev runs
// with fake services, so /api/auth/request returns the code. Writes a Playwright storageState to
// $SHIP_READY_STATE. Local dev only: a real studio never returns dev_code.
import { writeFileSync } from "node:fs";
import { request } from "@playwright/test";

const baseURL = process.env.SHIP_READY_BASE_URL;
const path = process.env.SHIP_READY_STATE;
if (!baseURL || !path) { console.error("NAMED STOP [SIGN_IN_ENV] SHIP_READY_BASE_URL and SHIP_READY_STATE are set by the check"); process.exit(2); }
const email = "owner@studio.example"; // the placeholder owner tests/e2e/serve.sh puts in .dev.vars
const ctx = await request.newContext({ baseURL });
const asked = await ctx.post("/api/auth/request", { data: { email } });
const { dev_code } = await asked.json().catch(() => ({}));
if (!dev_code) { console.error(`sign-in: no login code (status ${asked.status()}): fake services are off`); process.exit(1); }
const v = await ctx.post("/api/auth/verify", { data: { email, code: dev_code } });
if (!v.ok()) { console.error(`sign-in: verify answered ${v.status()}`); process.exit(1); }
// The first-run tour is marked done (app/lib/guides.ts TOUR_KEY), so each screen is judged itself,
// not under the tour card.
const state = await ctx.storageState();
state.origins = [{ origin: new URL(baseURL).origin, localStorage: [{ name: "ss-tour-done", value: "1" }] }];
writeFileSync(path, JSON.stringify(state));
await ctx.dispose();
console.log("OUTPUT SIGNED_IN");
