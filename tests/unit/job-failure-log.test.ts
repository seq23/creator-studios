// A failed job always says why in its log (jobs/common.py run → failure_fields → log), without
// her content: 26 Sep 2026 the staging voice job died logging only {"step": "job.failed"} while
// the real cause was a TypeError inside the watermarker. Driven in a real python3 against the
// real run() and Job.fail, with the Worker call stubbed.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const DRIVER = `
import json, sys
sys.path.insert(0, "jobs")
import common
posted = []
job = object.__new__(common.Job)
job._call = lambda method, path, body=None: posted.append(json.loads(body)) if body else None
job.spec = lambda: {"script": "Welcome back to the golden table, my secret friends. Pour the rosé.", "sample_key": "voice/sample/upl_abc123"}
job.done = lambda result: None
common.Job.from_env = classmethod(lambda cls: job)
kind = sys.argv[1]
def main(j, spec):
    if kind == "library":
        watermarker = None
        watermarker()  # the real failure: perth's watermarker was None
    if kind == "content":
        raise ValueError("could not speak: " + spec["script"] + " in /home/runner/work/x/voice.py")
    if kind == "quoted":
        raise KeyError("'Welcome to my kitchen'")
try:
    common.run(main)
except SystemExit as e:
    sys.stdout.write("RESULT " + json.dumps({"code": e.code, "posted": posted}) + "\\n")
`;

function run(kind: string): { logs: Record<string, unknown>[]; code: number; posted: { ok: boolean; safe_error: string }[] } {
  const lines = execFileSync("python3", ["-c", DRIVER, kind], { encoding: "utf8" }).trim().split("\n");
  const result = JSON.parse(lines.find((l) => l.startsWith("RESULT "))!.slice(7)) as { code: number; posted: { ok: boolean; safe_error: string }[] };
  return { logs: lines.filter((l) => !l.startsWith("RESULT ")).map((l) => JSON.parse(l) as Record<string, unknown>), ...result };
}

describe("a failed job says why, never her content", () => {
  it("a library TypeError logs its class, where, and the message; the Worker gets class + where; exit 1", () => {
    const r = run("library");
    const failed = r.logs.find((l) => l.step === "job.failed")!;
    expect(failed).toMatchObject({ error: "TypeError", detail: "'…' object is not callable" });
    expect(failed.where).toMatch(/^<string>:\d+$/);
    expect(r.code).toBe(1);
    expect(r.posted).toEqual([{ ok: false, safe_error: `TypeError at ${failed.where}` }]);
  });

  it("her script inside an error message is removed, whole and sentence by sentence; paths keep only the file name", () => {
    const r = run("content");
    const failed = r.logs.find((l) => l.step === "job.failed")!;
    expect(failed.error).toBe("ValueError");
    const detail = String(failed.detail);
    expect(detail).toBe("could not speak: … in voice.py");
    const all = JSON.stringify(r.logs) + JSON.stringify(r.posted);
    for (const leak of ["golden table", "secret", "rosé", "/home/runner"]) expect(all).not.toContain(leak);
  });

  it("anything quoted is removed even when it is not in the spec", () => {
    const failed = run("quoted").logs.find((l) => l.step === "job.failed")!;
    expect(failed).toMatchObject({ error: "KeyError" });
    expect(String(failed.detail)).not.toContain("kitchen");
  });
});
