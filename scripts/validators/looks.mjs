// Looks (jobs/looks.json): every Look she can pick must be something she can see before picking
// and something a test proves renders. Per Look:
//   - a name and a one-line description (20 to 140 characters, plain words)
//   - a preview picture public/looks/<id>.webp (a real WebP, at most 60 KB), made by
//     `python3 jobs/selftest_cut.py --looks-only --write-thumbs`
//   - mirrored in worker/domain/looks.ts (the Worker and the app read that copy)
//   - named in tests/unit/looks.test.ts (unit coverage of its options)
//   - a grid Look: its grid exists in looks.json and the guide help/guides/grid-looks.md shows its picture
// And the cut self-test renders the whole list (for lid in L.LOOK_IDS), no picture is left without
// a Look, and ids are unique. Zero Looks fails (Rule 0, in the runner).
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const problems = [];
  const data = JSON.parse(await readFile(path.join(root, "jobs", "looks.json"), "utf8"));
  const looks = Array.isArray(data.looks) ? data.looks : [];
  const mirror = await readFile(path.join(root, "worker", "domain", "looks.ts"), "utf8");
  const unit = await readFile(path.join(root, "tests", "unit", "looks.test.ts"), "utf8").catch(() => "");
  const selftest = await readFile(path.join(root, "jobs", "selftest_cut.py"), "utf8");
  const gridGuide = await readFile(path.join(root, "help", "guides", "grid-looks.md"), "utf8").catch(() => "");
  const thumbs = path.join(root, "public", "looks");
  const onDisk = new Set((await readdir(thumbs).catch(() => [])).filter((f) => f.endsWith(".webp")).map((f) => f.replace(/\.webp$/, "")));
  const seen = new Set();
  if (!unit) problems.push("tests/unit/looks.test.ts is missing");
  if (!/for lid in L\.LOOK_IDS:/.test(selftest)) problems.push("jobs/selftest_cut.py no longer renders every Look (for lid in L.LOOK_IDS)");
  // CI renders the singles and the grids in two parallel jobs: both halves must be there.
  const workflow = await readFile(path.join(root, ".github", "workflows", "job-cut.yml"), "utf8");
  if (!/kind: \[single, grid\]/.test(workflow) || !/--looks-only --looks-kind \$\{\{ matrix\.kind \}\}/.test(workflow)) problems.push(".github/workflows/job-cut.yml no longer renders both halves of the Looks (selftest-looks, kind: [single, grid])");
  for (const l of looks) {
    const id = String(l.id ?? "");
    if (!/^[a-z_]{3,30}$/.test(id)) {
      problems.push(`a Look has a bad id: ${JSON.stringify(l.id)}`);
      continue;
    }
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);
    if (!l.name || String(l.name).length > 30) problems.push(`${id}: no name (or longer than 30 characters)`);
    const d = String(l.description ?? "");
    if (d.length < 20 || d.length > 140) problems.push(`${id}: the description must be one line of 20 to 140 characters (has ${d.length})`);
    const file = path.join(thumbs, `${id}.webp`);
    const st = await stat(file).catch(() => null);
    if (!st) problems.push(`${id}: no preview picture public/looks/${id}.webp (run python3 jobs/selftest_cut.py --looks-only --write-thumbs)`);
    else {
      const head = (await readFile(file)).subarray(0, 12);
      if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WEBP") problems.push(`${id}: public/looks/${id}.webp is not a WebP`);
      if (st.size > 60 * 1024) problems.push(`${id}: preview picture is ${Math.round(st.size / 1024)} KB (max 60)`);
    }
    if (!mirror.includes(`id: "${id}"`)) problems.push(`${id}: missing from worker/domain/looks.ts (the mirror)`);
    if (!unit.includes(`"${id}"`)) problems.push(`${id}: not covered in tests/unit/looks.test.ts`);
    if (l.layout === "grid") {
      if (!data.grids?.[l.grid]) problems.push(`${id}: grid '${l.grid}' is not in looks.json grids`);
      if (!gridGuide.includes(`(/looks/${id}.webp)`)) problems.push(`${id}: the guide grid-looks.md has no picture of this grid`);
    }
  }
  for (const t of onDisk) if (!seen.has(t)) problems.push(`public/looks/${t}.webp has no Look`);
  return { items: looks.length, problems };
}
