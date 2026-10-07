// The voice job installs Chatterbox together with a setuptools that still has pkg_resources:
// without it the watermarker import silently became None and every narration failed with
// "TypeError" (Phase 0 live test, 26 Sep 2026). Drives jobs/voice.py install() in a real python3.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PY = `
import json, subprocess, sys
sys.path.insert(0, "jobs")
import voice
seen = []
subprocess.run = lambda args, **kw: seen.append(args)
voice.log = lambda *a, **k: None
voice.install()
sys.stdout.write(json.dumps(seen))
`;

describe("jobs/voice.py install", () => {
  it("installs Chatterbox with setuptools < 81 in the same pip call", () => {
    const calls = JSON.parse(execFileSync("python3", ["-c", PY], { encoding: "utf8" })) as string[][];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining([expect.stringMatching(/^chatterbox-tts/), "setuptools<81"]));
  });
});
