// A pull request opened by a workflow with GITHUB_TOKEN triggers no pull_request workflows, so
// its merge gate never runs and `land` can never see it green (Phase 0 live test, 26 Sep 2026:
// the help-screenshots PR #21 had no checks; a workflow_dispatch run of check.yml does not attach
// to the PR, and the PR's own run waits as "action_required"). Every workflow that runs
// `gh pr create` must approve its branch's check run (actions/runs/<id>/approve).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const dir = path.join(root, ".github", "workflows");
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  const problems = [];
  let creators = 0;
  for (const f of files) {
    const text = await readFile(path.join(dir, f), "utf8");
    if (!/gh pr create/.test(text)) continue;
    creators++;
    if (!/gh run list --workflow check\.yml --branch/.test(text) || !/actions\/runs\/\$rid\/approve/.test(text)) problems.push(`.github/workflows/${f}: opens a PR but never approves its check run, so the PR can never show green`);
    if (!/actions:\s*write/.test(text)) problems.push(`.github/workflows/${f}: needs permissions actions: write to approve the check run`);
  }
  return { items: files.length + creators, problems };
}
