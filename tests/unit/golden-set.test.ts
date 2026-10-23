// The weekly golden set (studio intelligence layer 9 seed) is wired, scheduled and covers every
// fixture business; a drop in score fails it (jobs/golden.py main, ALLOWED_DROP).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wf = readFileSync(".github/workflows/golden-set.yml", "utf8");
const golden = readFileSync("jobs/golden.py", "utf8");
const baseline = JSON.parse(readFileSync("jobs/golden/baseline.json", "utf8")) as { score: number; passing: Record<string, string[]> };
const fixtures = readdirSync("tests/fixtures/businesses").filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

describe("golden set", () => {
  it("runs weekly and on demand, the real script, free models only", () => {
    expect(wf).toMatch(/schedule:\s*\n\s*- cron: "[^"]+"/);
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain("python3 jobs/golden.py");
    expect(wf).toContain("GOLDEN_OPENROUTER_API_KEY");
    expect(wf).not.toContain("--write-baseline");
  });
  it("scores every fixture business and fails loudly on a drop", () => {
    for (const slug of fixtures) expect(golden, slug).toContain(`"${slug}": {`);
    expect(Object.keys(baseline.passing).sort()).toEqual([...fixtures].sort());
    for (const k of ["job_type", "before_after", "caption_noise"]) expect(Object.values(baseline.passing).flat()).toContain(k);
    expect(golden).toMatch(/if total < float\(base\.get\("score", 0\)\) - ALLOWED_DROP or lost:[\s\S]{0,200}golden\.DROP[^\n]*\n\s*loud\([^\n]*\n\s*return 1/);
    // Layer 9: six unlike businesses at least, the same six in fixtures, scenes and baseline; a drop is an error annotation.
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(golden).toContain("if sorted(fixtures) != sorted(SCENES) or len(SCENES) < 6:");
    expect(golden).toContain("::error title=Golden set dropped::");
  });
});
