"""The $0 model ladder (jobs/ai.py), owner 23 Oct 2026 "use the cloudflare free allowance too":
OpenRouter's free models first, then Cloudflare Workers AI within the studio's share, then the
local model. A Cloudflare refusal for the share stops further Cloudflare calls in the job."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ai as A  # noqa: E402


def payload(model: str) -> dict:
    return {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}


class LadderTest(unittest.TestCase):
    def setUp(self) -> None:
        A.reset()

    def test_openrouter_answer_never_touches_cloudflare(self):
        seen = []
        out = A.ask_openrouter("k", payload, ["m"], "text", usable=None, ask=lambda *a, **k: ("{}", {}), cloud=lambda *a: seen.append(a) or ("x", ""))
        self.assertEqual(out, ("{}", "m"))
        self.assertEqual(seen, [])
        self.assertEqual(A.CALLS_BY["cloudflare"], 0)

    def test_no_openrouter_falls_to_cloudflare_and_counts_it(self):
        got = []
        out = A.ask_openrouter(None, payload, ["m"], "text", usable=None, cloud=lambda m, t, k: got.append((m, t, k)) or ('{"a":1}', ""))
        self.assertEqual(out, ('{"a":1}', A.CLOUDFLARE_TAG))
        self.assertEqual(got, [([{"role": "user", "content": "hi"}], 50, "text")])
        self.assertEqual((A.CALLS_BY["cloudflare"], A.CALLS_BY["cloudflare_failed"]), (1, 0))

    def test_share_used_up_stops_cloudflare_for_the_job(self):
        calls = []
        cloud = lambda *a: calls.append(a) or (None, "budget_out")  # noqa: E731
        self.assertEqual(A.ask_openrouter(None, payload, ["m"], "text", usable=None, cloud=cloud), (None, ""))
        self.assertEqual(A.ask_openrouter(None, payload, ["m"], "text", usable=None, cloud=cloud), (None, ""))
        self.assertEqual(len(calls), 1)
        self.assertTrue(A.STATE["cloudflare_out"])

    def test_unusable_answer_is_a_failure_not_an_answer(self):
        out = A.ask_openrouter(None, payload, ["m"], "vision", usable=lambda s: s.startswith("{"), cloud=lambda *a: ("1. **Analyze", ""))
        self.assertEqual(out, (None, ""))
        self.assertEqual(A.CALLS_BY["cloudflare_failed"], 1)


if __name__ == "__main__":
    unittest.main()
