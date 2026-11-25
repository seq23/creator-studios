import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const secret = process.env.PNP_JOB_SECRET;
if (!secret) throw new Error("NAMED STOP [PNP_RECEIPTS_UNREAD] the Porch & Party job key is missing");
const stamp = Math.floor(Date.now() / 1000);
const signature = createHmac("sha256", secret).update(`${stamp}.pnp:receipts`).digest("hex");
const response = await fetch("https://pnpstudio.spryexecutiveos.com/api/jobs/pnp/receipts", {
  redirect: "error",
  signal: AbortSignal.timeout(20_000),
  headers: { "x-job-timestamp": String(stamp), "x-job-signature": signature },
});
if (!response.ok) throw new Error(`NAMED STOP [PNP_RECEIPTS_UNREAD] Studio returned HTTP ${response.status}`);
const rows = await response.json();
if (!Array.isArray(rows) || rows.length > 1000 || rows.some((r) =>
  typeof r?.id !== "string" || !/^[0-9a-f]{64}$/.test(r.id)
  || !["instagram", "tiktok", "facebook"].includes(r.channel) || !Number.isFinite(Date.parse(r.at)))) {
  throw new Error("NAMED STOP [PNP_RECEIPTS_UNREAD] Studio response was outside the receipt contract");
}
const file = "data/ledger/porch-and-party-posted.json";
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(rows.map(({ channel, id, at }) => ({ channel, id, at })), null, 2) + "\n");
console.log(`OUTPUT P&P Studio: ${rows.length} confirmed receipts`);
