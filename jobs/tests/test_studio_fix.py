"""The studio fix (owner's review of the Oct 22 cut, 23 Oct 2026), pinned:
  * words: a model's "thinking" is never spoken or shown, the CTA is never said twice, the caption is
    never read back; the final caption's EXACT layout; the AI note; words_pending instead of stock lines;
  * seeing: stages, heroes (new/final/after file names), events never mixed, blurry seconds never used,
    duplicates found;
  * clips: every clip ends on a hero held 2 s, follows its type's template, no repeats, distinct cuts;
    the golden playbook set across six businesses (a drop fails loudly);
  * the score is 0..100 from real checks with plain reasons;
  * looks: a grid only with as many different shots as cells.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import clipmaker as CM  # noqa: E402
import golden_playbook as G  # noqa: E402
import plan as P  # noqa: E402
import playbook as PB  # noqa: E402
import script_clean as SC  # noqa: E402
import stages as ST  # noqa: E402
from see import Shot, ShotSheet  # noqa: E402

# The real failure, read aloud in a voice over of the Oct 22 cut.
REAL_FAILURE = "1. **Analyze the Request:** * **Format:** Voice-over script for a 20-second vertical video. * **Tone:** warm. 2. **Draft:** Look at this porch."
HAS_FFMPEG = shutil.which("ffmpeg") is not None


class Words(unittest.TestCase):
    def test_the_real_reasoning_failure_is_never_spoken(self):
        self.assertTrue(SC.is_reasoning(REAL_FAILURE))
        self.assertEqual(SC.clean_script(REAL_FAILURE), "")
        self.assertEqual(SC.clean_line(REAL_FAILURE), "")
        for bad in ("**Hook:** Look at this", "Let me think about the hook first.", "The user wants a script. Here it is.", "<think>ok</think> Look.", "1. Look\n2. Book"):
            self.assertEqual(SC.clean_script(bad), "", bad)

    def test_plain_words_pass_cleaned(self):
        self.assertFalse(SC.is_reasoning("Watch this space come together. Every detail, done by hand."))
        self.assertEqual(SC.clean_script('"Watch this space come together." Every *detail*, done by hand.'), "Watch this space come together. Every detail, done by hand.")
        self.assertEqual(SC.clean_line("A **big** reveal"), "A big reveal")

    def test_cta_never_twice_caption_never_read_back_no_links(self):
        out = SC.clean_script("It all came together today. Book your date. It all came together today! Book your date now at example.com/request.", caption="It all came together today.", ctas=["Book your date"])
        self.assertEqual(out.lower().count("book your date"), 1)
        self.assertNotIn("example.com", out)
        self.assertNotIn("It all came together today", out)

    def test_copy_writer_rejects_reasoning_and_marks_words_pending(self):
        pl = P.Plan("montage", None, [P.Part("a", 0, 5, "after", "a finished room")])
        P.apply_copy([pl], {"items": [{"n": 0, "hook": REAL_FAILURE, "caption": "1. **Caption:** nice", "voice": REAL_FAILURE}]}, {}, [])
        self.assertTrue(pl.words_pending)
        self.assertNotIn("**", pl.hook + pl.caption)
        self.assertEqual(pl.voice, "")
        ok = P.Plan("montage", None, [P.Part("a", 0, 8, "after", "a finished room")])
        P.apply_copy([ok], {"items": [{"n": 0, "hook": "Walk into this room", "caption": "Soft light, every corner done.", "voice": "Here is the room, finished. Soft light everywhere.", "hashtags": ["#home"]}]}, {}, [])
        self.assertFalse(ok.words_pending)
        self.assertEqual(ok.voice, "Here is the room, finished. Soft light everywhere.")

    def test_the_exact_caption_layout(self):
        # Pinned string (owner, 23 Oct 2026): body, blank line, CTA line with link, blank line, hashtags,
        # blank line, the visible divider, "Made with AI".
        got = CM.compose_caption("Every detail done.", "Book your date: https://example.com/request", ["#one", "#two"], True)
        self.assertEqual(got, "Every detail done.\n\nBook your date: https://example.com/request\n\n#one #two\n\n—\nMade with AI")
        self.assertEqual(CM.compose_caption("Every detail done.", "Book your date: https://example.com/request", ["#one"], False), "Every detail done.\n\nBook your date: https://example.com/request\n\n#one")

    def test_ai_note_rule(self):
        self.assertTrue(CM.wants_ai_note({"ai_note": "all"}, False))
        self.assertTrue(CM.wants_ai_note({"ai_note": "ai_images"}, True))
        self.assertFalse(CM.wants_ai_note({"ai_note": "ai_images"}, False))

    def test_final_words_cta_link_place_send_and_pending(self):
        rules = CM.studio_rules({"studio_rules": {"cta_phrases": ["Book your date", "Request a quote", "Get in touch with us"], "cta_link": "https://example.com/request", "ai_note": "all", "place_words": ["Riverton"]}})
        pb = PB.load({})
        m = P.Plan("montage", None, [P.Part("a", 0, 8, "after", "x")], hook="Walk into this", caption="Soft light, every corner done. Book your date!", hashtags=["#home"])
        w = CM.final_words(m, rules, pb, 1, False)
        self.assertFalse(w["words_pending"])
        body, cta, tags, rest = w["caption"].split("\n\n")
        self.assertEqual(cta, "Request a quote: https://example.com/request")
        self.assertNotIn("Book your date", body)  # the CTA is said once, on its own line
        self.assertIn("Send this to", body)  # clip 1 of every 3 carries a send line
        self.assertIn("#Riverton", tags)
        self.assertEqual(rest, "—\nMade with AI")
        self.assertIn(" or ", CM.cta_phrase(rules, 2))  # every third clip combines two phrases
        stock = P.Plan("montage", None, [P.Part("a", 0, 8, "after", "x")], hook="Up close", caption="A closer look.")
        self.assertEqual(CM.final_words(stock, rules, pb, 0, False), {"caption": "", "hook_text": "", "hook_alt": None, "hashtags": [], "words_pending": True})

    def test_studio_rules_defaults_keep_old_behaviour(self):
        r = CM.studio_rules({"target_clips": {"min": 4, "max": 6}}, {"ctas": "Message us."})
        self.assertEqual(r["clip_target"], {"min": 4, "max": 6})
        self.assertEqual((r["ai_note"], r["bar"], r["cta_link"]), ("ai_images", 0, ""))
        self.assertEqual(r["cta_phrases"], ["Message us"])

    def test_voice_job_never_speaks_reasoning(self):
        import voice

        spoken: list[str] = []
        with mock.patch.object(voice, "load_voice", lambda spec, work: object()), mock.patch.object(voice, "speak", lambda m, s, p, cb=None: (spoken.append(s), (3.0, [(0.0, 3.0, s)]))[1]), mock.patch.object(
            voice, "upload_output", lambda *a: None
        ), mock.patch.object(voice, "download_input", lambda k, d: d), mock.patch.object(voice, "has_audio", lambda p: True), mock.patch.object(voice.subprocess, "run", lambda *a, **k: None), mock.patch.object(
            voice, "duration_of", lambda p: 8.0
        ), mock.patch.object(voice, "has_filter", lambda n: True):
            out = voice.batch(type("J", (), {"progress": lambda *a: None})(), {"mode": "batch", "items": [
                {"narration_id": "n1", "script": REAL_FAILURE, "speak": True, "narration_key": "k1", "clip_key": "c1", "output_key": "o1"},
                {"narration_id": "n2", "script": "A clean script. It is fine.", "speak": True, "narration_key": "k2", "clip_key": "c2", "output_key": "o2"},
            ]})
            with self.assertRaisesRegex(RuntimeError, "script_rejected"):
                voice.main(type("J", (), {"progress": lambda *a: None})(), {"script": REAL_FAILURE, "output_key": "x"})
        self.assertEqual([i["ok"] for i in out["items"]], [False, True])
        self.assertEqual(out["items"][0].get("reason"), "script_rejected")
        self.assertEqual(spoken, ["A clean script. It is fine."])


class Seeing(unittest.TestCase):
    def test_stages(self):
        self.assertEqual(ST.stage_of(Shot(0, 5, "an empty room", state="before", confidence=0.9)), "arrival")
        self.assertEqual(ST.stage_of(Shot(0, 5, "boxes of supplies being unloaded", state="in_progress", confidence=0.9)), "prep")
        self.assertEqual(ST.stage_of(Shot(0, 5, "two people at work", state="in_progress", people="working", confidence=0.9)), "team")
        self.assertEqual(ST.stage_of(Shot(0, 5, "the work going up", state="in_progress", confidence=0.9)), "process")
        self.assertEqual(ST.stage_of(Shot(0, 5, "the finished room", state="after", confidence=0.9)), "finished")
        self.assertEqual(ST.stage_of(Shot(0, 5, "close-up detail of the finish", state="after", confidence=0.9)), "detail")

    def test_hero_names(self):
        for n in ("porch-final.jpg", "IMG_1234 new.MOV", "after.jpg", "kitchen_after_2.png"):
            self.assertTrue(ST.name_is_hero(n), n)
        for n in ("IMG_3871.MOV", "afternoon.jpg", "renewal.mp4", "before.jpg"):
            self.assertFalse(ST.name_is_hero(n), n)

    def test_events_never_mixed(self):
        ev = ST.event_groups([{"id": "a", "date": "2026-10-20", "name": "x.jpg"}, {"id": "b", "date": "2026-10-20", "name": "y.jpg"}, {"id": "c", "date": "2026-09-01", "name": "z.jpg"}, {"id": "d", "date": None, "name": "w.jpg"}])
        self.assertEqual(ev["a"], ev["b"])
        self.assertNotEqual(ev["a"], ev["c"])
        self.assertNotIn(ev["d"], (ev["a"], ev["c"]))  # undated, with two events: never put into either story
        named = ST.event_groups([{"id": "1", "date": None, "name": "smith-party-01.jpg"}, {"id": "2", "date": None, "name": "smith-party-02.jpg"}, {"id": "3", "date": None, "name": "lee-wedding-1.jpg"}, {"id": "4", "date": None, "name": "lee-wedding-2.jpg"}])
        self.assertEqual(named["1"], named["2"])
        self.assertNotEqual(named["1"], named["3"])
        plain = ST.event_groups([{"id": "1", "date": None, "name": "prep.mp4"}, {"id": "2", "date": None, "name": "team.mp4"}])
        self.assertEqual(plain["1"], plain["2"])  # one-off names are not events
        self.assertEqual(ST.date_from_name("PXL_20261022_101500.mp4"), "2026-10-22")

    def test_duplicates_and_heroes(self):
        self.assertTrue(ST.same_picture(0b1011, 0b1010))
        self.assertFalse(ST.same_picture(0, (1 << 64) - 1))
        sheets = {"v": ShotSheet("v", 20, [Shot(0, 10, "the finished room", state="after", confidence=0.9), Shot(10, 20, "the finished room again", state="after", confidence=0.9)], "vision:t")}
        info = {"v": {"event": "e1", "hashes": {(0, 10): 123456, (10, 20): 123457}, "track": []}}
        looks = ST.build_looks(sheets, info)
        self.assertEqual(sum(1 for lk in looks if lk.hero_rank), 1)  # the same picture twice is one hero, not two

    def test_blurry_seconds_are_never_used(self):
        track = [1.0, 1.0, 0.2, 0.1, 0.9, 1.0, 1.0, 1.0]
        w = ST.best_window(track, 0.0, 8.0, 3.0)
        self.assertTrue(w and (w[0] >= 4.0 or w[1] <= 2.0), w)
        self.assertIsNone(ST.best_window([0.2] * 8, 0.0, 8.0, 2.0))

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
    def test_sharpness_and_steadiness_are_measured(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            sharp, blur = tmp / "s.mp4", tmp / "b.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x960:d=3:r=30", str(sharp)], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(sharp), "-vf", "gblur=sigma=10", str(blur)], check=True)
            self.assertGreaterEqual(min(ST.quality_track(sharp, 3)), ST.GOOD)
            self.assertLess(max(ST.quality_track(blur, 3)), ST.GOOD)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Clips(unittest.TestCase):
    def test_the_golden_playbook_set(self):
        problems, stats = G.run_all()
        self.assertEqual(problems, [], json.dumps(stats))
        self.assertGreaterEqual(len(stats), 6)

    def test_a_drop_fails_loudly(self):
        # Break it: footage with no finished view has no hero, so no clip may be made from it.
        fx = {"uploads": [{"id": "x", "photo": False, "name": "x.mp4", "date": None, "shots": [[0, 8, "before", "none", "an empty space"]]}], "expect": {"min_clips": 1, "types_all": ["payoff_first"]}}
        problems, _s = G.check_business("broken", fx)
        self.assertTrue(any("broken" in p for p in problems))

    def test_clip_target_caps_and_counts(self):
        fx = G.load()["event-decor"]
        looks, tracks, talk = G.looks_for(fx["uploads"])
        two = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 2}, None, tracks, talk)
        self.assertEqual(len(two), 2)
        self.assertEqual(CM.counts([p.clip_type for p in two])["distinct"], 2)

    def test_niche_playbook_formats_go_first(self):
        pb = PB.load({"niche_playbook": {"updated_at": "2026-10-20", "formats": ["Photo slideshow", "POV walk in"], "hooks": ["You won't believe this"], "caption_tips": ["Name the town"]}})
        self.assertEqual(pb["order"][:2], ["photo_slideshow", "pov_walk_in"])
        self.assertIn("niche_hooks_that_work", PB.prompt_lines(pb))

    def test_every_type_has_a_template_ending_on_the_hero(self):
        for tid, t in PB.TYPES.items():
            for k in ("opening", "length_s", "pacing_s", "ending", "loop"):
                self.assertIn(k, t, tid)
            self.assertEqual(t["ending"], "hero", tid)
        self.assertEqual(set(PB.TYPES), {"payoff_first", "pov_walk_in", "set_up_with_me", "prep_only", "team_working", "finished_walkthrough", "photo_details", "moving_photo", "video_to_photo", "photo_slideshow", "talk_to_camera"})


class Score(unittest.TestCase):
    def facts(self, **kw):
        base = {"clip_type": "payoff_first", "parts": [{"stage": "flash", "start": 0, "end": 1.2, "quality": 1}, {"stage": "arrival", "start": 0, "end": 3, "quality": 1}, {"stage": "process", "start": 0, "end": 3, "quality": 1}, {"stage": "hero", "start": 0, "end": 3, "quality": 1}],
                "hook": "Watch it come together", "caption": "Done. https://example.com/request", "cta_link": "https://example.com/request", "cta_phrases": ["Book your date"], "end_card": True, "overlap": 0.0, "repeats": False, "words_pending": False}
        return {**base, **kw}

    def test_a_good_clip_scores_high_with_reasons(self):
        s, why = CM.score_clip(self.facts(), PB.load({}))
        self.assertGreaterEqual(s, 90)
        self.assertTrue(all(isinstance(x, str) and x[0].isupper() for x in why))

    def test_each_defect_costs_points_and_says_why(self):
        pb = PB.load({})
        good, _ = CM.score_clip(self.facts(), pb)
        cases = {
            "blur": self.facts(parts=[{**p, "quality": 0.2} for p in self.facts()["parts"]]),
            "no hero end": self.facts(parts=self.facts()["parts"][:-1] + [{"stage": "", "start": 0, "end": 3, "quality": 1}]),
            "no cta": self.facts(caption="Done."),
            "repeats": self.facts(repeats=True),
            "same as another clip": self.facts(overlap=0.8),
            "unreadable hook": self.facts(hook="This is a very long hook that nobody can read on a phone screen"),
        }
        for name, f in cases.items():
            s, why = CM.score_clip(f, pb)
            self.assertLess(s, good, name)
            self.assertNotEqual(why, CM.score_clip(self.facts(), pb)[1], name)


class Looks(unittest.TestCase):
    def test_grid_needs_as_many_different_shots_as_cells(self):
        import cut
        import looks as L

        m = cut.Moment("a", "montage", 0, 10, [(0, 2), (2, 4), (4, 6), (6, 9)])
        m.part_keys, m.part_stages, m.hero_asset_id = ["a@0", "a@2", "a@2", "a@6"], ["process", "process", "process", "hero"], "a"
        self.assertEqual(len(cut.grid_body(m)), 2)  # a@2 twice counts once
        self.assertFalse(cut.look_fits(L.look_options("grid_four"), m, len(cut.grid_body(m))))
        m.part_keys = ["a@0", "a@2", "a@4", "a@6"]
        m.parts = [(0, 2), (2, 4), (4, 6), (6, 7), (7, 9)]
        m.part_keys, m.part_stages = ["a@0", "a@2", "a@4", "a@5", "a@7"], ["process"] * 4 + ["hero"]
        self.assertTrue(cut.look_fits(L.look_options("grid_four"), m, len(cut.grid_body(m))))
        m.clip_type = "payoff_first"
        self.assertFalse(cut.look_fits(L.look_options("reaction"), m, 4) if L.look_options("reaction")["layout"] == "pip" else False)


class Neutral(unittest.TestCase):
    def test_new_engine_files_carry_no_business_words(self):
        biz = Path(HERE.parent / "tests" / "fixtures" / "businesses")
        words = set()
        for f in biz.glob("*.json"):
            for svc in json.loads(f.read_text())["services"]:
                words |= {w for w in re.findall(r"[a-z]+", svc.lower()) if len(w) >= 4 and w not in ("tips", "color", "trims", "setups")}
        words |= {"porch", "porches", "balloon", "garland", "petals", "candles", "decorated", "undecorated", "grazing"}
        self.assertGreater(len(words), 15)
        for name in ("stages.py", "clipmaker.py", "playbook.py", "playbook.json", "script_clean.py", "script_rules.json"):
            text = (HERE / name).read_text().lower()
            hits = [w for w in words if re.search(rf"\b{w}\b", text)]
            self.assertEqual(hits, [], name)


if __name__ == "__main__":
    unittest.main()
