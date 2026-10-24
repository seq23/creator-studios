"""Clip quality for every studio (owner, 23 Oct 2026), pinned. From a real dump of 21 clips: every
score docked "The call to action is missing" though the studio never chose one; 3-second clips
scored 88 despite "3 s is the wrong length"; nearly all missed the payoff in the first 2 s; the
hooks were generic and repeated ("Boat mornings, latte art, pure joy" / "... latte art perfection").
  * calls to action are opt-in: none chosen = never docked, never mentioned, never written;
  * shorter than its type's range can never pass the bar, and the cut hides it with a plain reason;
  * payoff first: a clip with no payoff in its first 2 s opens on a flash of its hero;
  * hooks: near-duplicates in one dump are found and replaced, never kept;
  * the niche research's style (lengths, on-screen words, openings) reaches the cutter, writer and score.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import clipmaker as CM  # noqa: E402
import cut  # noqa: E402
import plan as P  # noqa: E402
import playbook as PB  # noqa: E402

# A creator's Brand Profile "ctas" section: a description of how she takes enquiries, not a phrase she chose.
DESCRIBED = "For brand deals: email someone@example.com with brand, category, timeline, goals. For content: ask questions in captions, encourage shares, follow for more."


def facts(**kw):
    base = {
        "clip_type": "talk_to_camera",
        "parts": [{"stage": "flash", "start": 0, "end": 1.2, "quality": 1}, {"stage": "", "start": 0, "end": 8, "quality": 1}, {"stage": "hero", "start": 0, "end": 3, "quality": 1}],
        "hook": "What I wear on a boat day", "caption": "My go-to for a day on the water.", "cta_link": "", "cta_phrases": [],
        "end_card": True, "overlap": 0.0, "repeats": False, "words_pending": False,
    }
    return {**base, **kw}


class CallToActionIsOptIn(unittest.TestCase):
    def test_none_chosen_is_never_docked_or_mentioned(self):
        s, why = CM.score_clip(facts(), PB.load({}))
        self.assertEqual(s, 100, why)
        self.assertFalse(any("call to action" in w.lower() for w in why), why)

    def test_a_studio_that_chose_one_is_still_checked(self):
        s, why = CM.score_clip(facts(cta_phrases=["Book your date"], cta_link="https://example.com/request"), PB.load({}))
        self.assertLess(s, 100)
        self.assertIn("The call to action is missing", why)
        ok, why2 = CM.score_clip(facts(cta_phrases=["Book your date"], cta_link="https://example.com/request", caption="Done. https://example.com/request"), PB.load({}))
        self.assertEqual(ok, 100, why2)

    def test_a_described_profile_section_is_not_a_chosen_cta(self):
        self.assertEqual(P.ctas({"ctas": DESCRIBED}), [])
        self.assertEqual(P.ctas({"ctas": "Not in your docs yet."}), [])
        self.assertEqual(P.ctas({"ctas": "- Shop the look\n- Link in bio: https://x.com"}), ["Shop the look"])
        self.assertEqual(cut.cta_line({"ctas": DESCRIBED}), "")
        rules = CM.studio_rules({"studio_rules": {"cta_phrases": [], "cta_link": ""}}, {"ctas": DESCRIBED})
        self.assertEqual(rules["cta_phrases"], [])
        self.assertEqual(CM.cta_line(rules, 0), "")
        self.assertEqual(CM.cta_card(rules, 0), "")

    def test_no_cta_means_the_caption_carries_none(self):
        class M:
            hook, hook_alt, caption, hashtags, words_pending = "What I wear on a boat day", "", "My go-to for a day on the water.", ["#ootd"], False
        rules = CM.studio_rules({"studio_rules": {"cta_phrases": []}}, {"ctas": DESCRIBED})
        w = CM.final_words(M(), rules, PB.load({}), 0, False)
        self.assertEqual(w["caption"], "My go-to for a day on the water.\n\n#ootd")

    def test_the_writers_are_told_no_cta_when_none_was_chosen(self):
        self.assertIn("NO call to action at all", P.COPY_SYSTEM)
        ctx = cut.voice_context({"brand_profile": {"ctas": DESCRIBED, "voice": "Warm"}})
        self.assertEqual(ctx["calls_to_action"], [])


class LengthBites(unittest.TestCase):
    def test_a_3_second_clip_can_never_pass_a_bar(self):
        parts = [{"stage": "", "start": 0, "end": 1.0, "quality": 1}, {"stage": "hero", "start": 0, "end": 2.0, "quality": 1}]
        for ctype in ("talk_to_camera", "finished_walkthrough"):
            s, why = CM.score_clip(facts(clip_type=ctype, parts=parts), PB.load({}))
            self.assertLessEqual(s, CM.SHORT_CAP, (ctype, s))
            self.assertTrue(why[0].startswith("3 s is too short"), why)
        self.assertLess(CM.SHORT_CAP, 50)

    def test_the_cut_hides_a_short_clip_whatever_the_bar(self):
        m = cut.Moment("a", "talking_head", 0, 3, [(0, 3)])
        m.clip_type = "talk_to_camera"
        self.assertTrue(cut.clip_too_short(m, PB.load({})))
        m.parts = [(0, 9)]
        self.assertFalse(cut.clip_too_short(m, PB.load({})))
        src = Path(cut.__file__).read_text(encoding="utf-8")
        self.assertIn("or clip_too_short(m, pb)) and not ch.hidden_reason", src)
        self.assertIn('m.hidden_reason = f"too short:', src)

    def test_a_short_speech_moment_takes_more_of_its_video(self):
        m = cut.Moment("a", "talking_head", 10, 13, [(10.0, 13.0)])
        m.clip_type = "talk_to_camera"
        self.assertTrue(cut.reach_type_length(m, PB.load({}), 60.0))
        self.assertEqual(m.parts, [(10.0, 18.0)])
        near_end = cut.Moment("a", "talking_head", 18, 20, [(18.0, 20.0)])
        near_end.clip_type = "talk_to_camera"
        cut.reach_type_length(near_end, PB.load({}), 20.0)
        self.assertEqual(near_end.parts, [(12.0, 20.0)])


class PayoffFirst(unittest.TestCase):
    def test_a_clip_with_no_payoff_up_front_opens_on_its_hero(self):
        m = cut.Moment("talk", "talking_head", 0, 12, [(0.0, 10.0), (4.0, 7.0)])
        m.part_assets, m.part_stages, m.part_keys, m.clip_type = ["talk", "hero"], ["", "hero"], ["", "hero@4"], "talk_to_camera"
        self.assertTrue(cut.payoff_first(m, PB.load({})))
        self.assertEqual(m.parts[0], (4.0, 5.2))
        self.assertEqual(m.part_stages, ["flash", "", "hero"])
        self.assertEqual(m.part_assets, ["hero", "talk", "hero"])
        f = facts(parts=[{"stage": st, "start": s, "end": e, "quality": 1} for st, (s, e) in zip(m.part_stages, m.parts)])
        self.assertIn("Shows the payoff in the first 2 seconds", CM.score_clip(f, PB.load({}))[1])
        self.assertFalse(cut.payoff_first(m, PB.load({})))  # never twice

    def test_a_clip_that_already_opens_on_the_payoff_is_left_alone(self):
        m = cut.Moment("a", "montage", 0, 8, [(0.0, 3.0), (3.0, 6.0)])
        m.part_stages, m.clip_type = ["finished", "hero"], "finished_walkthrough"
        self.assertFalse(cut.payoff_first(m, PB.load({})))


class DistinctHooks(unittest.TestCase):
    REAL = ["Latte art: everyday elegance", "Boat mornings, latte art, pure joy", "Boat mornings, latte art perfection", "Sailing sunrise, latte love", "Morning waves meet perfect latte art", "Sip, shuffle, and sparkle"]

    def test_the_real_repeats_are_found(self):
        self.assertTrue(CM.near_duplicate(self.REAL[1], self.REAL[2]))
        self.assertTrue(CM.near_duplicate(self.REAL[0], self.REAL[4]))  # "latte art" twice
        self.assertFalse(CM.near_duplicate("What I wear on a boat day", "My 5-minute glam before school pickup"))
        self.assertEqual(CM.duplicate_hooks(self.REAL), [1, 2, 4])

    def test_repeats_are_replaced_never_kept(self):
        class Tr:
            def text_in(self, s, e):
                return "Okay so this is my favourite way to start a Sunday"

            def words_in(self, s, e):
                return [1]

        class Src:
            transcript = Tr()

        moments = []
        for i, h in enumerate(self.REAL):
            m = cut.Moment("a", "talking_head", 0, 10, [(0.0, 10.0)], hook=h, hook_alt="Brooklyn mom, boat day glam" if i == 1 else "")
            moments.append((m, Src()))
        stats = cut.distinct_hooks(moments, {"brand_profile": {}}, None, None, PB.load({}))
        hooks = [m.hook for m, _ in moments if not m.words_pending]
        self.assertEqual(CM.duplicate_hooks(hooks), [], hooks)
        self.assertEqual(stats["repeats"], 3)
        self.assertEqual(moments[1][0].hook, "Brooklyn mom, boat day glam")
        self.assertEqual(stats["alt"] + stats["rewritten"] + stats["pending"], 3)
        # Never "her own first spoken line" (24 Oct 2026: lines of speech shipped as hooks).
        self.assertNotIn("spoken", stats)
        said = Src.transcript.text_in(0, 10)
        self.assertFalse(any(CM.echoes_speech(m.hook, said) for m, _ in moments if m.hook))

    def test_a_repeat_left_over_costs_points_and_says_why(self):
        s, why = CM.score_clip(facts(hook_repeats=True), PB.load({}))
        self.assertLess(s, 100)
        self.assertIn("The hook says nearly the same as another clip's", why)

    def test_hook_writers_get_her_voice_rules(self):
        for needle in ("HER voice", "never a generic slogan", "never copy another creator's words", "already_used_hooks"):
            self.assertIn(needle, cut.HOOK_RULES)
        ctx = cut.voice_context({"brand_profile": {"voice": "Honest and glam", "video_feel": "Talks fast, laughs"}})
        self.assertEqual(ctx["her_voice"], "Honest and glam")
        self.assertIn("leads", ctx["what_leads"])
        self.assertTrue(ctx["what_leads"].startswith("how_her_videos_feel leads"))


class NicheStyleReachesTheCut(unittest.TestCase):
    NICHE = {"formats": ["Talking to camera"], "hooks": ["POV: …"], "caption_tips": [], "openings": ["Best moment first"], "lengths": {"talk_to_camera": [12, 40], "pov_walk_in": [1, 400]}, "on_screen_words": 6, "caption_style": "Short and personal"}

    def test_lengths_words_and_openings_merge_within_reason(self):
        pb = PB.load({"niche_playbook": self.NICHE})
        self.assertEqual(pb["types"]["talk_to_camera"]["length_s"], [12.0, 40.0])
        lo, hi = pb["types"]["pov_walk_in"]["length_s"]
        self.assertGreaterEqual(lo, 5.0)
        self.assertLessEqual(hi, 25 + 15)
        self.assertEqual(pb["hook_max_words"], 6)
        self.assertEqual(pb["niche_openings"], ["Best moment first"])
        self.assertEqual(PB.load({})["types"]["talk_to_camera"]["length_s"], [8, 45])  # the library itself is untouched
        self.assertIn("niche_openings_payoff_first", PB.prompt_lines(pb))

    def test_the_score_and_cutter_use_the_niche_lengths(self):
        pb = PB.load({"niche_playbook": self.NICHE})
        parts = [{"stage": "flash", "start": 0, "end": 1.2, "quality": 1}, {"stage": "", "start": 0, "end": 6, "quality": 1}, {"stage": "hero", "start": 0, "end": 2.5, "quality": 1}]
        self.assertLessEqual(CM.score_clip(facts(parts=parts), pb)[0], CM.SHORT_CAP)
        self.assertGreater(CM.score_clip(facts(parts=parts), PB.load({}))[0], CM.SHORT_CAP)
        seven = "One two three four five six seven"
        self.assertFalse(CM._readable_hook(seven, pb["hook_max_words"]))
        ctx = cut.voice_context({"niche_playbook": self.NICHE, "brand_profile": {}})
        self.assertEqual(ctx["on_screen_words_max"], 6)
        self.assertEqual(ctx["what_leads"], "the niche research leads until she uploads past videos")


if __name__ == "__main__":
    unittest.main()
