"""Studio intelligence layer 6 (owner's plan, 22 Oct 2026): the critic checks its own work.

Pinned: the critic loop is bounded (at most 2 re-cuts, then hidden with the reason in plain words);
the rules need no model; a re-cut acts on the reason (before shots out, captions off, neutral words);
a verdict the model cannot give is never a silent pass of a rules failure.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "jobs"))

import critic as C  # noqa: E402
import cut  # noqa: E402
import plan as P  # noqa: E402
import see as V  # noqa: E402


class LoopTest(unittest.TestCase):
    def test_always_failing_clip_is_recut_twice_then_hidden(self):
        renders, recuts = [], []
        out = C.critic_loop(
            "m0",
            lambda m: renders.append(m) or f"r:{m}",
            lambda m, r: C.Verdict(False, ["text_mismatch"], "vision"),
            lambda m, reasons, attempt: recuts.append((reasons, attempt)) or f"m{attempt + 1}",
        )
        self.assertEqual(len(renders), 1 + C.MAX_RECUTS)
        self.assertEqual([a for _r, a in recuts], [0, 1])
        self.assertEqual(recuts[0][0], ["text_mismatch"])  # the reason is fed back
        self.assertEqual(out.recuts, 2)
        self.assertEqual(out.hidden_reason, C.REASON_WORDS["text_mismatch"])
        self.assertEqual(out.rendered, "r:m2")

    def test_a_passing_recut_is_kept_visible(self):
        out = C.critic_loop("m0", lambda m: m, lambda m, r: C.Verdict(m == "fixed"), lambda m, reasons, a: "fixed")
        self.assertEqual((out.recuts, out.hidden_reason, out.moment), (1, None, "fixed"))

    def test_a_clip_that_cannot_be_recut_is_hidden_at_once(self):
        n = []
        out = C.critic_loop("m0", lambda m: n.append(m), lambda m, r: C.Verdict(False, ["privacy"], "vision"), lambda m, reasons, a: None)
        self.assertEqual((len(n), out.recuts, out.hidden_reason), (1, 0, C.REASON_WORDS["privacy"]))


class RulesTest(unittest.TestCase):
    def setUp(self):
        self.services = ["alpha work", "beta work"]

    def test_rules(self):
        g = P.Ground("alpha work", self.services, "a finished corner", False, True)
        self.assertEqual(C.rules_check("Alpha work, up close", "", "Have a look.", g, ["after"], "montage", "", False), [])
        self.assertIn("text_mismatch", C.rules_check("Beta work done", "", "", g, ["after"], "montage", "", False))
        self.assertIn("before_as_finished", C.rules_check("Have a look", "", "", g, ["after", "before"], "transformation", "", False))
        self.assertIn("before_as_finished", C.rules_check("Have a look", "", "", g, ["before", "after"], "walkthrough", "", False))
        self.assertEqual(C.rules_check("Have a look", "", "", g, ["before", "n/a"], "talking", "", True), [])
        self.assertIn("noise_captions", C.rules_check("Have a look", "", "", g, ["after"], "montage", "what's wrong", False))

    def test_parse_verdict(self):
        self.assertIsNone(C.parse_verdict({"nope": True}))
        self.assertEqual(C.parse_verdict({"text_matches_picture": True, "before_shown_as_finished": False, "noise_in_captions": False, "privacy_hazard": False}), [])
        self.assertEqual(C.parse_verdict({"text_matches_picture": False, "privacy_hazard": True}), ["text_mismatch", "privacy"])


class RecutTest(unittest.TestCase):
    def test_recut_drops_before_shots_and_turns_captions_off_and_stays_grounded(self):
        services = ["alpha work", "beta work"]
        sheets = {
            "b": V.ShotSheet("b", 10, [V.Shot(0, 10, what="an empty corner", state="before", confidence=0.9)], "vision:t"),
            "a": V.ShotSheet("a", 12, [V.Shot(0, 12, what="the finished corner", state="after", service="alpha work", confidence=0.9)], "vision:t"),
        }
        m = cut.Moment("a", "montage", 0, 9, [(0, 3), (0, 6)], hook="Beta work glow up", caption="x")
        m.part_assets, m.part_states, m.shape, m.service, m.on_screen = ["b", "a"], ["before", "after"], "walkthrough", "alpha work", "an empty corner · the finished corner"
        n = cut.recut_moment(m, ["before_as_finished", "noise_captions", "text_mismatch"], 1, None, {}, sheets, services, {"ctas": "Book your beta work.\nMessage us."})
        self.assertEqual(n.parts, [(0, 6)])
        self.assertEqual((n.asset_id, n.part_assets, n.part_states, n.captions_off, n.recuts), ("a", None, ["after"], True, 1))
        g = P.Ground(n.service, services, n.on_screen, False, True)
        for t in (n.hook, n.hook_alt, n.caption):
            self.assertTrue(P.grounded_ok(t, g)[0], t)
        self.assertNotIn("beta", n.caption.lower())

    def test_recut_that_leaves_nothing_returns_none(self):
        sheets = {"b": V.ShotSheet("b", 10, [V.Shot(0, 10, what="an empty corner", state="before", confidence=0.9)], "vision:t")}
        m = cut.Moment("b", "montage", 0, 5, [(0, 5)])
        m.part_states = ["before"]
        self.assertIsNone(cut.recut_moment(m, ["before_as_finished"], 0, None, {}, sheets, [], {}))
        m2 = cut.Moment("b", "montage", 0, 5, [(0, 5)])
        m2.part_states = ["after"]
        self.assertIsNone(cut.recut_moment(m2, ["privacy"], 0, None, {}, sheets, [], {}))  # nothing explains it: hide


if __name__ == "__main__":
    unittest.main()


class RoundsTest(unittest.TestCase):
    """The batched critic (quota fix, 23 Oct 2026): one vision pass per round for every clip the rules
    passed, one batched re-cut per round, the same bound of 2 re-cuts, then hidden with the reason."""

    def test_rounds_batch_the_model_and_stay_bounded(self):
        renders, vision_calls, recut_calls = [], [], []
        out = C.critic_rounds(
            ["ok", "bad", "rulebad", "dead"],
            lambda m: None if m == "dead" else renders.append(m) or f"r:{m}",
            lambda m, r: ["before_as_finished"] if m.startswith("rulebad") else [],
            lambda pairs: vision_calls.append([m for m, _r in pairs]) or [(["text_mismatch"] if m.startswith("bad") else []) for m, _r in pairs],
            lambda reqs: recut_calls.append([(m, a) for m, _r, a in reqs]) or [f"{m}+" for m, _r, _a in reqs],
        )
        self.assertEqual(len(vision_calls), 3)  # one batched pass per round (first + 2 re-cut rounds)
        self.assertEqual(vision_calls[0], ["ok", "bad"])  # the rules' failure never reaches the model
        self.assertEqual(len(recut_calls), 2)  # one batched re-cut per round
        self.assertEqual(recut_calls[0], [("bad", 0), ("rulebad", 0)])
        ok, bad, rulebad, dead = out
        self.assertEqual((ok.hidden_reason, ok.recuts), (None, 0))
        self.assertEqual((bad.recuts, bad.hidden_reason), (2, C.REASON_WORDS["text_mismatch"]))
        self.assertEqual((rulebad.recuts, rulebad.hidden_reason), (2, C.REASON_WORDS["before_as_finished"]))
        self.assertIsNone(dead)
        self.assertNotIn("dead", renders)

    def test_no_model_answer_lets_the_rules_decide(self):
        out = C.critic_rounds(["a"], lambda m: m, lambda m, r: [], lambda pairs: [None for _ in pairs], lambda reqs: [None for _ in reqs])
        self.assertEqual((out[0].verdict.ok, out[0].verdict.source), (True, "rules"))

    def test_batch_verdicts_parse_per_clip(self):
        got = C.parse_batch_verdicts({"clips": [{"clip": 2, "text_matches_picture": False}, {"clip": 1, "text_matches_picture": True, "privacy_hazard": False}, {"clip": 9}]}, 3)
        self.assertEqual(got, [[], ["text_mismatch"], None])
