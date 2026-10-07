// The jobs' one OpenRouter client (jobs/common.py openrouter_content), driven in a real python3
// with the network stubbed: an answer cut off for length is asked again with four times the
// room, and a complete answer is taken at once (Phase 0 live test, 25 Sep 2026).
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const DRIVER = `
import json, sys, io, urllib.request
sys.path.insert(0, "jobs")
import common
answers = json.loads(sys.argv[1])
sent = []
class R(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
def fake(req, timeout=0):
    sent.append(json.loads(req.data.decode())["max_tokens"])
    content, finish = answers.pop(0)
    return R(json.dumps({"choices": [{"message": {"content": content}, "finish_reason": finish}]}).encode())
urllib.request.urlopen = fake
common.log = lambda *a, **k: None
text, _ = common.openrouter_content("k", {"model": "m", "max_tokens": 2500}, usable=common.json_object_in)
sys.stdout.write(json.dumps({"text": text, "sent": sent}))
`;

function drive(answers: [string, string][]) {
  return JSON.parse(execFileSync("python3", ["-c", DRIVER, JSON.stringify(answers)], { encoding: "utf8" })) as { text: string; sent: number[] };
}

describe("jobs: one OpenRouter client", () => {
  it("asks again with 4x the room when the answer stopped for length", () => {
    expect(drive([['{"who": "The Golden Table is a', "length"], ['{"who":"The Golden Table"}', "stop"]])).toEqual({ text: '{"who":"The Golden Table"}', sent: [2500, 10000] });
  });
  it("takes a complete answer at once, and stops at the 16,000 ceiling", () => {
    expect(drive([['{"ok":1}', "stop"]]).sent).toEqual([2500]);
    expect(drive([["{", "length"], ["{", "length"], ["{", "length"]]).sent).toEqual([2500, 10000, 16000]);
  });
});
