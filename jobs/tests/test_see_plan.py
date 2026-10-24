"""Studio intelligence, layers 2 and 4 (owner's plan, 22 Oct 2026): the shot sheet and the story plan.

Six unlike fixture businesses (tests/fixtures/businesses, the same files tests/unit/services-of.test.ts
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
import os
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
    def test_six_unlike_businesses_with_their_own_services(self):
        self.assertEqual(sorted(FIX), ["bakery", "car-detailer", "event-decor", "hair-salon", "landscaper", "talking-head"])
        # The golden set scores exactly these (layer 9).
        import golden as G

        self.assertEqual(sorted(G.SCENES), sorted(FIX))
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

    def test_neutral_hooks_differ_across_a_dump(self):
        """23 Oct 2026 live re-cut: 8 before-and-after clips shared 2 hooks. Six clips of one shape get six
        different hooks, every one grounded."""
        f = FIX["event-decor"]
        svc = f["services"][0]
        shapes = {"transformation": [P.Part("a", 0, 4, "before", "x"), P.Part("b", 0, 4, "after", "x")],
                  "walkthrough": [P.Part("a", 0, 8, "after", "x")], "montage": [P.Part("a", 0, 8, "after", "x")]}
        for shape, parts in shapes.items():
            pl = P.Plan(shape, svc, parts)
            g = pl.ground(f["services"])
            hooks = [P.neutral_copy(pl, f["profile"], f["services"], i)["hook"] for i in range(6)]
            self.assertEqual(len(set(hooks)), 6, (shape, hooks))
            for h in hooks:
                self.assertTrue(P.grounded_ok(h, g)[0], (shape, h))

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
        # Where it came from survives the round trip (it decides whether the sheet is saved again).
        self.assertEqual((back.source, back.shots[0].service, back.shots[0].state), (sh.source, services[0], "after"))
        self.assertNotEqual(sh.source, "cached")
        old = dict(sh.to_json(), source="cached")  # rows saved before 23 Oct 2026
        self.assertEqual(V.ShotSheet.from_json(old, "s", 10, services).source, "cached")

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


class QuotaTest(unittest.TestCase):
    """The quota fix (23 Oct 2026): every job spends at most its budget of the shared free-model quota (1,000 a day since 24 Oct 2026, the studios keep ~500)."""

    def setUp(self):
        import ai as A

        self.A = A
        self.old = (A.openrouter_content, A.time.sleep, A.OPENROUTER_JOB_BUDGET)
        A.time.sleep = lambda *_: None
        A.reset()
        V.QUOTA_OUT["out"] = False
        os.environ.pop("VISION_LOCAL", None)
        A._VLM.clear()

    def tearDown(self):
        self.A.openrouter_content, self.A.time.sleep, self.A.OPENROUTER_JOB_BUDGET = self.old
        self.A.reset()
        V.QUOTA_OUT["out"] = False
        self.A._VLM.clear()

    def _raise(self, calls, body=b"busy"):
        import io
        import urllib.error

        def f(*_a, **_k):
            calls.append(1)
            raise urllib.error.HTTPError("u", 429, "busy", {}, io.BytesIO(body))

        return f

    def test_a_round_of_429s_stops_further_model_calls(self):
        calls = []
        self.A.openrouter_content = self._raise(calls)
        img = Path(__file__)
        self.assertEqual(V.ask_vision("k", "s", "t", img, "vision"), (None, ""))
        first = len(calls)
        self.assertEqual(first, 2)  # two models at most, no pause-and-retry round
        self.assertTrue(V.QUOTA_OUT["out"])
        self.assertEqual(V.ask_vision("k", "s", "t", img, "critic"), (None, ""))
        self.assertEqual(len(calls), first)  # no call once the quota is out
        self.assertEqual(self.A.CALLS_BY["openrouter"], 2)
        self.assertEqual(self.A.CALLS_BY["openrouter_failed"], 2)

    def test_the_daily_quota_message_trips_at_once(self):
        calls = []
        self.A.openrouter_content = self._raise(calls, b'{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits"}}')
        self.assertEqual(V.ask_vision("k", "s", "t", Path(__file__), "vision"), (None, ""))
        self.assertEqual(len(calls), 1)
        self.assertTrue(self.A.STATE["quota_out"])

    def test_the_job_budget_caps_calls(self):
        calls = []

        def ok(*_a, **_k):
            calls.append(1)
            return '{"shots": []}', {}

        self.A.openrouter_content = ok
        self.A.OPENROUTER_JOB_BUDGET = 3
        for _ in range(6):
            V.ask_vision("k", "s", "t", Path(__file__), "vision")
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.A.report()["openrouter"], 3)

    def test_no_local_model_without_vision_local(self):
        self.assertIsNone(self.A.ask_local_vlm("s", "t", Path(__file__), "vision"))
        self.assertEqual(self.A.CALLS_BY["local_vlm"], 0)


class BatchSheetTest(unittest.TestCase):
    def test_parse_batch_covers_each_video_with_its_own_frames(self):
        batch = [{"asset_id": "a", "duration": 8.0, "times": [1.0, 3.0, 5.0, 7.0]}, {"asset_id": "b", "duration": 4.0, "times": [1.0, 3.0]}]
        ans = {"videos": [
            {"video": 1, "shots": [{"frames": [1, 2], "state": "before", "service": "alpha work", "confidence": 0.9}, {"frames": [3, 4], "state": "after", "service": "alpha work", "confidence": 0.9}]},
            {"video": 2, "shots": [{"frames": [1, 2], "state": "after", "service": "alpha work", "confidence": 0.8}]},
            {"video": 7, "shots": [{"frames": [1, 1]}]},
        ]}
        got = V.parse_batch(ans, batch, ["alpha work"], "vision:x")
        self.assertEqual(sorted(got), ["a", "b"])
        self.assertEqual([s.state for s in got["a"].shots], ["before", "after"])
        self.assertEqual(got["a"].shots[-1].end, 8.0)
        self.assertEqual(got["b"].shots[0].end, 4.0)
        self.assertEqual(V.parse_batch({"shots": []}, batch, [], "x"), {})

    def test_three_videos_take_one_call_and_cached_sheets_none(self):
        import ai as A

        calls = []
        old = V.ask_vision, V.extract_frames, V.labelled_grid
        try:
            V.extract_frames = lambda video, d, out, max_cells=None: ([Path(__file__)], [1.0])
            V.labelled_grid = lambda groups, out, cols=6: Path(__file__)

            def fake(key, system, text, image, kind, max_tokens=3000, local=True):
                calls.append(json.loads(text))
                return {"videos": [{"video": i + 1, "shots": [{"frames": [1, 1], "state": "after", "service": "alpha work", "confidence": 0.9}]} for i in range(len(calls[-1]["videos"]))]}, "openrouter:m"

            V.ask_vision = fake
            items = [{"asset_id": f"v{i}", "video": Path(__file__), "duration": 2.0, "notes": ""} for i in range(4)]
            cached = {"v3": V.ShotSheet("v3", 2.0, [V.Shot(0, 2, state="after", service="alpha work", confidence=0.9)], "vision:openrouter:m").to_json()}
            got = V.see_videos("k", items, ["alpha work"], Path("/tmp"), cached, {"alpha work": "a tidy finished corner"})
            self.assertEqual(len(calls), 1)  # v0..v2 in one picture; v3 was saved and never looked at again
            self.assertEqual(len(calls[0]["videos"]), 3)
            self.assertEqual(calls[0]["what_each_service_looks_like"], {"alpha work": "a tidy finished corner"})
            self.assertEqual(got["v3"].source, "vision:openrouter:m")  # provenance kept, not "cached"
            self.assertTrue(all(V.worth_saving(got[k]) for k in got))
        finally:
            V.ask_vision, V.extract_frames, V.labelled_grid = old
            A.reset()

    def test_only_a_vision_sheet_is_saved(self):
        self.assertTrue(V.worth_saving(V.ShotSheet("a", 1.0, [V.Shot(0, 1)], "vision:openrouter:m")))
        self.assertTrue(V.worth_saving(V.ShotSheet("a", 1.0, [V.Shot(0, 1)], "vision:local_vlm:m")))
        self.assertFalse(V.worth_saving(V.ShotSheet("a", 1.0, [V.Shot(0, 1)], "local")))
        self.assertFalse(V.worth_saving(V.unsure_sheet("a", 1.0)))


class KnowTheBusinessTest(unittest.TestCase):
    """Layer 1: the Brand Profile says what each service looks like and which shapes fit."""

    services = ["alpha work", "beta work", "gamma kits"]
    profile = {
        "service_looks": "• Alpha work: a finished corner with soft lights\nBeta work: a tidy shelf, labels facing out\nNot a service: ignored",
        "video_shapes": "Alpha work: walk-through, before and after\nAll: close-ups",
    }

    def test_service_looks(self):
        self.assertEqual(P.service_looks(self.profile, self.services), {"alpha work": "a finished corner with soft lights", "beta work": "a tidy shelf, labels facing out"})
        self.assertEqual(P.service_looks({}, self.services), {})

    def test_shapes_fit(self):
        self.assertEqual(P.shapes_fit(self.profile, "alpha work"), ["walkthrough", "transformation"])
        self.assertEqual(P.shapes_fit(self.profile, "beta work"), ["montage"])
        self.assertIsNone(P.shapes_fit({}, "alpha work"))

    def test_fit_picks_among_possible_shapes(self):
        sh = V.ShotSheet("a", 20.0, [V.Shot(0, 4, state="before", confidence=0.9), V.Shot(4, 20, state="after", service="alpha work", confidence=0.9)], "vision:x")
        self.assertEqual(P.choose_shape([sh], "alpha work")[0], "transformation")
        self.assertEqual(P.choose_shape([sh], "alpha work", fit=["walkthrough", "transformation"])[0], "walkthrough")
        # A shape the footage cannot make is never picked: no talking here, so the natural shape stays.
        self.assertEqual(P.choose_shape([sh], "alpha work", fit=["talking"])[0], "transformation")
        # Her own pick still wins over the profile.
        self.assertEqual(P.choose_shape([sh], "alpha work", override="montage", fit=["walkthrough"])[0], "montage")

    def test_copy_prompt_carries_what_the_service_looks_like(self):
        pl = P.Plan("montage", "alpha work", [P.Part("a", 0, 4, "after", "a corner")])
        self.assertEqual(json.loads(P.copy_prompt([pl], self.profile))["clips"][0]["what_this_service_looks_like"], "a finished corner with soft lights")


class AnswersAndMemoryTest(unittest.TestCase):
    """Layers 7-9 in the planner: her before answer, the shapes she keeps, a corrected service, careful mode."""

    def test_her_before_answer_makes_a_before_and_after(self):
        a = V.ShotSheet("a", 6.0, [V.Shot(0, 6, what="an empty corner", state=V.UNSURE, confidence=0.2)], "vision:x")
        b = V.ShotSheet("b", 8.0, [V.Shot(0, 8, what="the finished corner", state="after", service="alpha work", confidence=0.9)], "vision:x")
        self.assertNotEqual(P.choose_shape([a, b], "alpha work")[0], "transformation")
        self.assertEqual(P.mark_before([a, b], ["a"]), 1)
        self.assertEqual(P.choose_shape([a, b], "alpha work")[0], "transformation")
        plans = P.plan_clips([a, b], "transformation", "alpha work", 4)
        self.assertTrue(any(p.parts[0].state == "before" and p.parts[-1].state == "after" for p in plans))

    def test_memory_fit_and_careful_order(self):
        mem = {"shapes": {"walkthrough": {"approved": 4, "rejected": 1, "views": 50}, "montage": {"approved": 1, "rejected": 4, "views": 5}, "transformation": {"approved": 1, "rejected": 0}}}
        self.assertEqual(P.memory_fit(mem), ["walkthrough"])  # montage kept under half the time; 1 review is too few
        self.assertEqual(P.combined_fit(["transformation"], mem), ["transformation", "walkthrough"])
        self.assertEqual(P.combined_fit(["transformation"], {**mem, "approach": "careful"}), ["walkthrough", "transformation"])
        self.assertIsNone(P.combined_fit(None, {}))
        self.assertEqual(P.careful_quota(10, {"approach": "careful"}), 5)
        self.assertEqual(P.careful_quota(10, {}), 10)

    def test_relabel_and_turned_down_hooks(self):
        self.assertEqual(P.relabel("alpha work", {"relabel": {"alpha work": "Beta work"}}, ["alpha work", "beta work"]), "beta work")
        self.assertEqual(P.relabel("alpha work", {}, ["alpha work"]), "alpha work")
        pl = P.Plan("montage", "alpha work", [P.Part("a", 0, 4, "after", "a corner")])
        P.apply_copy([pl], {"items": [{"n": 0, "hook": "Same old hook", "caption": "x"}]}, {}, ["alpha work"], None, ["same old hook"])
        self.assertNotEqual(pl.hook.lower(), "same old hook")
        prompt = json.loads(P.copy_prompt([pl], {}, memory={"kept_hooks": ["Walk in to this"], "turned_down_hooks": ["Same old hook"]}))
        self.assertEqual(prompt["what_the_owner_kept_and_turned_down"]["kept_hooks"], ["Walk in to this"])


class LocalModelSheetTest(unittest.TestCase):
    """The $0 backup: the local open model answers one flat question per stretch of a video."""

    def test_segments_and_flat_answers_join(self):
        import ai as A

        self.assertEqual(V.segments(12.0), [(0.0, 12.0)])
        self.assertEqual(V.segments(46.0), [(0.0, 15.33), (15.33, 30.67), (30.67, 46.0)])
        answers = iter(['{"what":"an empty room","state":"before","people":"none","service":"unsure"}',
                        '{"what":"the finished room","state":"after","people":"none","service":"alpha work","confidence":0.9}',
                        '{"what":"the finished room, close","state":"after","people":"none","service":"alpha work","confidence":0.7}'])
        old = A.ask_local_vlm, V.contact_sheet, os.environ.get("VISION_LOCAL")
        try:
            A.ask_local_vlm = lambda *a, **k: next(answers)
            V.contact_sheet = lambda frames, out: Path(__file__)
            os.environ["VISION_LOCAL"] = "1"
            import tempfile

            work = Path(tempfile.mkdtemp())
            f = work / "x.jpg"
            f.write_bytes(b"jpg")
            b = {"asset_id": "a", "duration": 46.0, "frames": [f] * 12, "times": [i * 4.0 + 2 for i in range(12)], "notes": ""}
            sh = V.local_vlm_sheet(b, ["alpha work"], None, work)
        finally:
            A.ask_local_vlm, V.contact_sheet = old[0], old[1]
            if old[2] is None:
                os.environ.pop("VISION_LOCAL", None)
            else:
                os.environ["VISION_LOCAL"] = old[2]
        self.assertTrue(sh.source.startswith("vision:local_vlm:"))
        self.assertEqual([(s.state, s.service) for s in sh.shots], [("before", V.UNSURE), ("after", "alpha work")])
        self.assertEqual((sh.shots[1].start, sh.shots[1].end), (15.33, 46.0))
        self.assertEqual(sh.shots[0].confidence, V.LOCAL_DEFAULT_CONFIDENCE)  # no confidence given: fairly sure, not unsure
        self.assertTrue(V.worth_saving(sh))

    def test_no_local_model_without_the_switch(self):
        os.environ.pop("VISION_LOCAL", None)
        self.assertIsNone(V.local_vlm_sheet({"asset_id": "a", "duration": 5.0, "frames": [], "times": []}, [], None, Path("/tmp")))


class HerServiceTest(unittest.TestCase):
    def test_her_service_takes_finished_shots_with_no_service_of_their_own(self):
        # Saved sheets labelled with an old service list read back as "unsure"; her pick names the dump.
        a = V.ShotSheet("a", 6.0, [V.Shot(0, 6, what="an empty corner", state="before", confidence=0.9)], "vision:x")
        b = V.ShotSheet("b", 8.0, [V.Shot(0, 8, what="the finished corner", state="after", service=V.UNSURE, confidence=0.9)], "vision:x")
        self.assertEqual(P.pools([a, b], "alpha work")["after"], [])
        self.assertEqual(len(P.pools([a, b], "alpha work", hers=True)["after"]), 1)
        self.assertEqual(P.choose_shape([a, b], "alpha work", hers=True)[0], "transformation")
        plans = P.plan_clips([a, b], "transformation", "alpha work", 4, hers=True)
        self.assertTrue(plans and plans[0].parts[-1].state == "after")
        # A finished shot of ANOTHER service is still never used.
        c = V.ShotSheet("c", 8.0, [V.Shot(0, 8, state="after", service="beta work", confidence=0.9)], "vision:x")
        self.assertEqual(P.pools([c], "alpha work", hers=True)["after"], [])
