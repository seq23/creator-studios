"""Key order (owner's word 24 Oct 2026, Mercedes): a host-first studio's job sends the host's OpenRouter
key first and her own pasted key (spec llm_key_fallback) as the backup. The job moves to her key when the
host's is refused (401/402), out of its daily quota (429 per-day), or no model tried gives an answer, and
asks her key BEFORE Workers AI. With no backup key (every other studio) nothing changes."""
from __future__ import annotations

import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ai as A  # noqa: E402
import common as C  # noqa: E402

DAILY = b'{"error":{"message":"Rate limit exceeded: free-models-per-day."}}'


def payload(model: str) -> dict:
    return {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}


def http(code: int, body: bytes = b"") -> urllib.error.HTTPError:
    return urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(body))


class KeyOrderTest(unittest.TestCase):
    def setUp(self) -> None:
        A.reset()
        self.sleep = A.time.sleep
        A.time.sleep = lambda *_: None
        C.set_openrouter_fallback(None)

    def tearDown(self) -> None:
        A.time.sleep = self.sleep
        A.reset()
        C.set_openrouter_fallback(None)

    def ask_by_key(self, answers: dict, seen: list):
        def ask(key, body, **_k):
            seen.append(key)
            a = answers[key]
            if isinstance(a, Exception):
                raise a
            return a, {}

        return ask

    def test_daily_quota_on_the_host_key_moves_to_her_key_before_workers_ai(self):
        C.set_openrouter_fallback("sk-hers")
        seen, cloud = [], []
        ask = self.ask_by_key({"sk-host": http(429, DAILY), "sk-hers": '{"ok":1}'}, seen)
        out = A.ask_openrouter("sk-host", payload, ["m1", "m2"], "text", ask=ask, cloud=lambda *a: cloud.append(a) or ("x", ""))
        self.assertEqual(out, ('{"ok":1}', "m1"))
        self.assertEqual(seen, ["sk-host", "sk-hers"])
        self.assertEqual(cloud, [])
        self.assertFalse(A.STATE["quota_out"])
        # The rest of the job stays on her key.
        A.ask_openrouter("sk-host", payload, ["m1"], "text", ask=ask)
        self.assertEqual(seen[-1], "sk-hers")

    def test_refused_host_key_401_and_402_move_to_her_key(self):
        for code in (401, 402):
            A.reset()
            C.set_openrouter_fallback("sk-hers")
            seen = []
            ask = self.ask_by_key({"sk-host": http(code), "sk-hers": '{"ok":1}'}, seen)
            self.assertEqual(A.ask_openrouter("sk-host", payload, ["m1"], "text", ask=ask), ('{"ok":1}', "m1"), code)
            self.assertEqual(seen, ["sk-host", "sk-hers"], code)

    def test_no_answer_from_every_model_on_the_host_key_asks_her_key_then_workers_ai(self):
        C.set_openrouter_fallback("sk-hers")
        seen, cloud = [], []
        ask = self.ask_by_key({"sk-host": http(500), "sk-hers": http(500)}, seen)
        out = A.ask_openrouter("sk-host", payload, ["m1", "m2"], "text", ask=ask, cloud=lambda *a: cloud.append(a) or ('{"c":1}', ""))
        self.assertEqual(out, ('{"c":1}', A.CLOUDFLARE_TAG))
        self.assertEqual(seen, ["sk-host", "sk-host", "sk-hers", "sk-hers"])
        self.assertEqual(len(cloud), 1)

    def test_without_a_backup_key_nothing_changes(self):
        seen = []
        ask = self.ask_by_key({"sk-host": http(429, DAILY)}, seen)
        self.assertEqual(A.ask_openrouter("sk-host", payload, ["m1", "m2"], "text", ask=ask, cloud=lambda *a: (None, "budget_out")), (None, ""))
        self.assertEqual(seen, ["sk-host"])
        self.assertTrue(A.STATE["quota_out"])

    def test_both_keys_used_up_trips_the_daily_breaker(self):
        C.set_openrouter_fallback("sk-hers")
        seen = []
        ask = self.ask_by_key({"sk-host": http(429, DAILY), "sk-hers": http(429, DAILY)}, seen)
        self.assertEqual(A.ask_openrouter("sk-host", payload, ["m1"], "text", ask=ask, cloud=lambda *a: (None, "budget_out")), (None, ""))
        self.assertEqual(seen, ["sk-host", "sk-hers"])
        self.assertTrue(A.STATE["quota_out"])

    def test_common_client_moves_a_direct_caller_to_her_key(self):
        """Jobs that call common.openrouter_content directly (research, brand finder, extract)."""
        C.set_openrouter_fallback("sk-hers")
        sent = []
        real = C._post_openrouter

        def post(key, body, timeout):
            sent.append(key)
            if key == "sk-host":
                raise http(429, DAILY)
            return {"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}]}

        C._post_openrouter = post
        try:
            self.assertEqual(C.openrouter_content("sk-host", payload("m"))[0], "hi")
            self.assertEqual(sent, ["sk-host", "sk-hers"])
            # A busy model (429 without per-day) is not the key's fault: it propagates, body intact.
            C.set_openrouter_fallback("sk-hers")
            C._post_openrouter = lambda *_a: (_ for _ in ()).throw(http(429, b"busy"))
            with self.assertRaises(urllib.error.HTTPError) as e:
                C.openrouter_content("sk-host", payload("m"))
            self.assertEqual(e.exception.read(), b"busy")
            self.assertFalse(C.OPENROUTER_KEYS["switched"])
        finally:
            C._post_openrouter = real

    def test_run_reads_the_backup_key_from_the_spec(self):
        class FakeJob:
            def spec(self):
                return {"llm_key_fallback": "sk-hers"}

            def done(self, result):
                self.result = result

        job = FakeJob()
        real, current = C.Job.from_env, C._CURRENT
        C.Job.from_env = classmethod(lambda cls: job)
        try:
            C.run(lambda j, spec: {"fallback": C.OPENROUTER_KEYS["fallback"]})
        finally:
            C.Job.from_env, C._CURRENT = real, current
        self.assertEqual(job.result, {"fallback": "sk-hers"})
        self.assertEqual(json.dumps(C.OPENROUTER_KEYS["switched"]), "false")


if __name__ == "__main__":
    unittest.main()
