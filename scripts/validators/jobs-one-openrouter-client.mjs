// Every job talks to OpenRouter through jobs/common.py `openrouter_content` (one client, one
// "stopped for length → ask again with more room" rule). Three hand-rolled clients in extract,
// brand_finder and cut each lost the end of a reasoning model's answer (Phase 0 live test,
// 25 Sep 2026). Fails if any other file under jobs/ names the chat-completions endpoint.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const dir = path.join(root, "jobs");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".py"));
  const problems = [];
  let helper = false;
  for (const f of files) {
    const text = await readFile(path.join(dir, f), "utf8");
    const direct = /openrouter\.ai\/api\/v1\/chat\/completions/.test(text);
    if (f === "common.py") helper = direct && /def openrouter_content\(/.test(text);
    else if (direct) problems.push(`jobs/${f}: calls OpenRouter directly; use common.openrouter_content`);
  }
  if (!helper) problems.push("jobs/common.py: openrouter_content (the one OpenRouter client) is missing");
  return { items: files.length, problems };
}
