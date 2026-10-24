// 23 Oct 2026: the apt install of ffmpeg timed out three times in a row (5 minutes each) on the live
// cut job and killed it; the runners' apt mirror had hung on 7 and 22 Oct too. ffmpeg comes from the
// static build (.github/scripts/ffmpeg-static.sh, which itself falls back to apt). Fails when any
// workflow asks apt-install.sh for ffmpeg, or a workflow that runs a job needing ffmpeg has no static step.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const NEEDS = ["job-cut.yml", "job-voice.yml", "job-fullvideo.yml", "job-photopack.yml", "job-pastvideos.yml", "golden-set.yml"];

export default async function ({ root }) {
  const dir = path.join(root, ".github", "workflows");
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  const problems = [];
  for (const f of files) {
    const y = await readFile(path.join(dir, f), "utf8");
    if (/apt-install\.sh[^\n]*\bffmpeg\b/.test(y)) problems.push(`.github/workflows/${f}: installs ffmpeg through apt; use bash .github/scripts/ffmpeg-static.sh`);
    if (NEEDS.includes(f) && !/run: bash \.github\/scripts\/ffmpeg-static\.sh/.test(y)) problems.push(`.github/workflows/${f}: needs ffmpeg and has no static ffmpeg step`);
  }
  return { items: files.length, problems };
}
