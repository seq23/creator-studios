"""Studio intelligence, layers 2 and 4 (owner's plan, 22 Oct 2026): the shot sheet and the story plan.

Four unlike fixture businesses (tests/fixtures/businesses, the same files tests/unit/services-of.test.ts
reads) each with their own services. Pinned here:
  * before/after fires only when both a before and an after shot are present;
  * a before shot is never last and never in a clip that is not a before/after;
  * the unsure case gives a neutral hook, and the 22 Oct live-test hook ("Empty …? Watch it glow up!"
    on a test pattern) is refused by the grounded-text guard;
  * only speech said to the camera can become captions;
  * the model's shot sheet is clamped: unknown labels and low confidence become "unsure".
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "jobs"))

import plan as P  # noqa: E402
import see as V  # noqa: E402
from looks import Word  # noqa: E402

FIX = {p.stem: json.loads(p.read_text()) for p in (ROOT / "tests" / "fixtures" / "businesses").glob("*.json")}


def shot(s, e, state, service, what, people="none", conf=0.9, **kw):
    sh = V.Shot(s, e, what=what, subject=what, state=state, people=people, service=service, confidence=conf)
    for k, v in kw.items():
        setattr(sh, k, v)
    return sh


def sheet(aid, dur, *shots, source="vision:test"):
    return V.ShotSheet(aid, dur, list(shots), source)


def decor_dump(with_before=True):
    f = FIX["event-decor"]
    svc = f["services"][0]
    sheets = [sheet("a_after", 12, shot(0, 6, "after", svc, "a finished arch over a doorway"), shot(6, 12, "after", svc, "close on the arch at night"))]
    if with_before:
        sheets.insert(0, sheet("a_before", 8, shot(0, 8, "before", V.UNSURE, "an empty doorway with bare walls")))
    return f, svc, sheets


class FixturesTest(unittest.TestCase):
    def test_four_unlike_businesses_with_their_own_services(self):
        self.assertEqual(sorted(FIX), ["car-detailer", "event-decor", "hair-salon", "talking-head"])
        labels = [s.lower() for f in FIX.values() for s in f["services"]]
        self.assertEqual(len(labels), len(set(labels)))


class ShapeTest(unittest.TestCase):
    def test_before_after_only_when_both_states_are_present(self):
        f, svc, sheets = decor_dump(with_before=True)
        service, sure = P.dump_service(sheets, None, f["services"])
        self.assertEqual((service, sure), (svc, True))
        self.assertEqual(P.choose_shape(sheets, service)[0], "transformation")
        _f, _s, only_after = decor_dump(with_before=False)
        self.assertNotEqual(P.choose_shape(only_after, svc)[0], "transformation")
        only_before = [sheet("b", 8, shot(0, 8, "before", V.UNSURE, "an empty chair"))]
        self.assertNotEqual(P.choose_shape(only_before, None)[0], "transformation")

    def test_her_pick_cannot_force_a_before_after_without_both(self):
        _f, svc, only_after = decor_dump(with_before=False)
        shape, why = P.choose_shape(only_after, svc, override="transformation")
        self.assertNotEqual(shape, "transformation")
        self.assertIn("before", why)

    def test_salon_before_after_and_detailer_walkthrough_and_talking_head(self):
        salon = FIX["hair-salon"]["services"]
        sheets = [sheet("s1", 10, shot(0, 4, "before", salon[0], "a client's hair before styling", people="working"), shot(4, 10, "after", salon[0], "sleek straight hair, finished"))]
        svc, _ = P.dump_service(sheets, None, salon)
        self.assertEqual(svc, salon[0])
        self.assertEqual(P.choose_shape(sheets, svc)[0], "transformation")
        det = FIX["car-detailer"]["services"]
        car = [sheet("c1", 20, shot(0, 20, "after", det[1], "a slow pass along a glossy finished hood"))]
        self.assertEqual(P.choose_shape(car, det[1])[0], "walkthrough")
        talk = FIX["talking-head"]["services"]
        th = [sheet("t1", 30, shot(0, 30, "n/a", talk[0], "a woman talking to the camera at a desk", people="to_camera"))]
        self.assertEqual(P.choose_shape(th, talk[0], {"t1": False})[0], "talking")
        # Camera sound off: nobody can be heard, so it is not a talking-to-camera video.
        self.assertNotEqual(P.choose_shape(th, talk[0], {"t1": True})[0], "talking")


class PlanTest(unittest.TestCase):
    def test_before_is_never_last_and_never_outside_a_transformation(self):
        f, svc, sheets = decor_dump()
        plans = P.plan_clips(sheets, "transformation", svc, 8)
        self.assertTrue(any(pl.shape == "transformation" for pl in plans))
        for pl in plans:
            self.assertNotEqual(pl.last_state(), "before")
            if pl.shape != "transformation":
                self.assertFalse(any(p.state == "before" for p in pl.parts), pl.shape)
            else:
                self.assertEqual(pl.parts[0].state, "before")
                self.assertEqual(pl.parts[-1].state, "after")
                self.assertGreaterEqual(len({p.asset_id for p in pl.parts}), 2)  # joins the two videos
            self.assertLessEqual(pl.length, P.MAX_CLIP_S + 0.01)

    def test_shots_with_a_privacy_hazard_are_left_out(self):
        _f, svc, sheets = decor_dump()
        sheets[1].shots[0].privacy = ["house_number"]
        for pl in P.plan_clips(sheets, "transformation", svc, 8):
            self.assertFalse(any(p.asset_id == "a_after" and p.start < 6 for p in pl.parts))


class GroundedTest(unittest.TestCase):
    def test_the_live_test_hook_is_refused_on_unsure_footage(self):
        f = FIX["event-decor"]
        g = P.Ground(None, f["services"], "", False, False)
        for bad in ["Empty backdrop? Watch it glow up!", "Watch it glow up!", "Empty space?", "Balloon garlands for your day"]:
            self.assertFalse(P.grounded_ok(bad, g)[0], bad)

    def test_unsure_gives_a_neutral_hook(self):
        f = FIX["event-decor"]
        pl = P.Plan("montage", None, [P.Part("x", 0, 8, V.UNSURE, "")])
        out = P.neutral_copy(pl, f["profile"], f["services"], 0)
        self.assertEqual(out["hook"], "Have a look")
        g = pl.ground(f["services"])
        for k in ("hook", "hook_alt", "caption"):
            self.assertTrue(P.grounded_ok(out[k], g)[0], out[k])
        # The call to action naming one service is not used when nothing is sure.
        self.assertNotIn("garland", out["caption"].lower())

    def test_other_services_and_automation_are_refused(self):
        f = FIX["hair-salon"]
        g = P.Ground(f["services"][0], f["services"], "sleek straight hair", True, True)
        self.assertTrue(P.grounded_ok("Silk press glow up", g)[0])
        self.assertEqual(P.grounded_ok("Fresh knotless braids today", g), (False, "other_service"))
        self.assertEqual(P.grounded_ok("Voice over added automatically", g), (False, "automation"))
        g2 = P.Ground(f["services"][0], f["services"], "a client's hair before styling", True, False)
        self.assertEqual(P.grounded_ok("The big reveal", g2), (False, "finished_without_after"))

    def test_brand_hashtags_stay_other_service_tags_go(self):
        f = FIX["event-decor"]
        g = P.Ground(f["services"][1], f["services"], "a backdrop wall of flowers", False, True)
        own = {h.lower().lstrip("#") for h in P.profile_hashtags(f["profile"])}
        self.assertTrue(P.hashtag_ok("#GlowLane", g, own))
        self.assertFalse(P.hashtag_ok("#balloongarland", g, own))
        self.assertFalse(P.hashtag_ok("#beforeandafter", g, own))

    def test_model_copy_kept_when_grounded_replaced_when_not(self):
        f, svc, sheets = decor_dump()
        plans = P.plan_clips(sheets, "transformation", svc, 2)[:2]
        answer = json.dumps({"items": [
            {"n": 0, "hook": "From bare walls to wow", "hook_alt": "Watch it come together", "caption": "Message us to book your date.", "hashtags": ["#GlowLane", "#tablecenterpieces"]},
            {"n": 1, "hook": "Table centerpieces done right", "hook_alt": "Added automatically", "caption": "Our dessert displays!", "hashtags": []},
        ]})
        fell = P.write_copy("key", plans, f["profile"], f["services"], "m", lambda _k, _p: answer)
        self.assertEqual(plans[0].hook, "From bare walls to wow")
        self.assertNotIn("#tablecenterpieces", plans[0].hashtags)
        self.assertNotEqual(plans[1].hook, "Table centerpieces done right")
        self.assertNotEqual(plans[1].hook_alt, "Added automatically")
        self.assertGreaterEqual(fell, 3)

    def test_a_hook_is_never_repeated_across_the_dump(self):
        f, svc, sheets = decor_dump()
        plans = P.plan_clips(sheets, "transformation", svc, 3)[:3]
        same = {"n": 0, "hook": "Walk in to this.", "hook_alt": "Come home to this.", "caption": "Message us to book your date.", "hashtags": []}
        answer = json.dumps({"items": [{**same, "n": i} for i in range(len(plans))]})
        P.write_copy("key", plans, f["profile"], f["services"], "m", lambda _k, _p: answer)
        self.assertEqual(plans[0].hook, "Walk in to this.")
        self.assertEqual(sum(1 for pl in plans if pl.hook == "Walk in to this."), 1)
        self.assertEqual(sum(1 for pl in plans if pl.hook_alt == "Come home to this."), 1)

    def test_a_plan_never_has_more_parts_than_the_worker_keeps(self):
        f = FIX["event-decor"]
        svc = f["services"][0]
        sheets = [sheet(f"b{i}", 8, shot(0, 8, "before", V.UNSURE, f"bare {i}")) for i in range(3)] + [sheet(f"g{i}", 8, shot(0, 8, "in_progress", svc, f"work {i}")) for i in range(3)] + [sheet(f"a{i}", 12, shot(0, 12, "after", svc, f"done {i}")) for i in range(6)]
        for pl in P.plan_clips(sheets, "transformation", svc, 12):
            self.assertLessEqual(len(pl.parts), P.MAX_PARTS)

    def test_no_model_means_neutral_grounded_copy(self):
        f, svc, sheets = decor_dump()
        plans = P.plan_clips(sheets, "transformation", svc, 3)
        P.write_copy(None, plans, f["profile"], f["services"], "m", lambda *_: "")
        for pl in plans:
            g = pl.ground(f["services"])
            for k in ("hook", "hook_alt", "caption"):
                self.assertTrue(P.grounded_ok(getattr(pl, k), g)[0], getattr(pl, k))


class SpeechTest(unittest.TestCase):
    def test_only_speech_to_the_camera_becomes_captions(self):
        sh = sheet("t", 20, shot(0, 10, "n/a", V.UNSURE, "someone talking to the camera", people="to_camera"), shot(10, 20, "after", V.UNSURE, "a room, people chatting off camera", people="others"))
        words = [Word(1.0, 1.4, "hello"), Word(12.0, 12.3, "what's"), Word(12.3, 12.6, "wrong")]
        self.assertEqual([w.text for w in P.keep_to_camera(words, sh)], ["hello"])
        # Nobody could look: the camera-sound rule decides, unchanged.
        self.assertEqual(len(P.keep_to_camera(words, V.unsure_sheet("t", 20))), 3)


class SheetParseTest(unittest.TestCase):
    def test_grid_answer_to_seconds_and_unsure_when_low_confidence(self):
        services = FIX["car-detailer"]["services"]
        times = [1.0, 3.0, 5.0, 7.0, 9.0]
        ans = {"shots": [
            {"frames": [1, 2], "what": "a dusty seat", "state": "unfinished", "people": "none", "service": "interior detailing", "confidence": 0.8, "privacy": ["plate", "bogus"]},
            {"frames": [3, 5], "what": "test pattern", "state": "after", "service": "Teeth whitening", "confidence": 0.3},
        ]}
        sh = V.parse_sheet(ans, "c", 10.0, times, services, "vision:x")
        self.assertEqual([(s.start, s.end) for s in sh.shots], [(0.0, 4.0), (4.0, 10.0)])
        self.assertEqual((sh.shots[0].state, sh.shots[0].service, sh.shots[0].privacy), ("before", "Interior detailing", ["plate"]))
        self.assertEqual((sh.shots[1].state, sh.shots[1].service), (V.UNSURE, V.UNSURE))
        self.assertIsNone(V.parse_sheet({"nope": 1}, "c", 10.0, times, services, "vision:x"))

    def test_saved_sheet_round_trips(self):
        services = FIX["hair-salon"]["services"]
        sh = sheet("s", 10, shot(0, 10, "after", services[0], "sleek hair"))
        back = V.ShotSheet.from_json(json.loads(json.dumps(sh.to_json())), "s", 10, services)
        self.assertEqual((back.source, back.shots[0].service, back.shots[0].state), ("cached", services[0], "after"))

    def test_local_labels_under_the_floor_are_unsure(self):
        services = FIX["event-decor"]["services"]
        lab = V.local_frame_labels({services[0]: 0.42, services[1]: 0.38, V.UNSURE: 0.2}, {"before": 0.4, "after": 0.35, "n/a": 0.25}, services)
        self.assertEqual((lab["service"], lab["state"]), (V.UNSURE, V.UNSURE))
        lab = V.local_frame_labels({services[0]: 0.8, services[1]: 0.1}, {"before": 0.1, "after": 0.85, "n/a": 0.05}, services)
        self.assertEqual((lab["service"], lab["state"]), (services[0], "after"))

    def test_frame_grid_is_bounded(self):
        self.assertEqual(V.frame_times(8.0), (2.0, 4))
        step, n = V.frame_times(600.0)
        self.assertEqual(n, V.MAX_CELLS)
        self.assertAlmostEqual(step, 20.0)


class PlainLineTest(unittest.TestCase):
    def test_looks_like(self):
        self.assertEqual(P.looks_like("x", True, "transformation", {"a": "off", "b": "off"}), {"service": "x", "shape": "transformation", "camera": "off", "sure": True})
        self.assertEqual(P.looks_like(None, False, "montage", {"a": "kept"})["sure"], False)


if __name__ == "__main__":
    unittest.main()
