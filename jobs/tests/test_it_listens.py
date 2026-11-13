"""It listens (owner, 13 Nov 2026): what she wrote reaches the words and the plan, look-alike
posts are one post, a video that could not be used says why, and with a model connected but no
model answering nothing generic is made.
Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import clipmaker as CM  # noqa: E402
import cut  # noqa: E402
import golden_playbook as G  # noqa: E402
import plan as P  # noqa: E402
import playbook as PB  # noqa: E402


def footage():
    return G.looks_for(G.load()["event-decor"]["uploads"])


class NoteReachesTheWords(unittest.TestCase):
    def test_her_note_is_in_the_words_prompt_and_absent_when_she_wrote_none(self):
        pl = P.Plan("montage", None, [P.Part("a", 0, 5, "after", "a finished room")])
        with_note = json.loads(P.copy_prompt([pl], {}, owner_note="Baby shower in Germantown,\n  it was for a girl"))
        self.assertEqual(with_note["owner_note"], "Baby shower in Germantown, it was for a girl")
        self.assertNotIn("owner_note", json.loads(P.copy_prompt([pl], {})))
        self.assertIn("owner_note", P.COPY_SYSTEM)

    def test_write_copy_sends_the_note_to_the_model(self):
        seen = {}

        def ask(_key, payload):
            seen["user"] = json.loads(payload["messages"][1]["content"])
            return "{}"

        P.write_copy("k", [P.Plan("montage", None, [P.Part("a", 0, 5, "after", "a finished room")])], {}, [], "m", ask, owner_note="lean funny")
        self.assertEqual(seen["user"]["owner_note"], "lean funny")


class NoteReachesThePlan(unittest.TestCase):
    def test_how_many_is_planned_not_cut_down_afterwards(self):
        looks, tracks, talk = footage()
        one = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 1}, None, tracks, talk, {"count": 1})
        self.assertEqual(len(one), 1)

    def test_leave_out_removes_the_shots_that_show_it(self):
        looks, tracks, talk = footage()
        word = next(w for lk in looks for w in (lk.shot.what or "").lower().split() if len(w) >= 5 and w not in CM._SMALL)
        hit = {lk.key for lk in looks if CM.shows(lk.shot.what, word)}
        self.assertTrue(hit)
        plans = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 6}, None, tracks, talk, {"avoid": [word]})
        self.assertFalse(any(p.key in hit for pl in plans for p in pl.parts))
        # the control: without the note those shots are used
        free = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 6}, None, tracks, talk)
        self.assertTrue(any(p.key in hit for pl in free for p in pl.parts))

    def test_must_include_is_taken_first_and_what_was_never_seen_is_said(self):
        looks, tracks, talk = footage()
        free = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 1}, None, tracks, talk)
        in_first = {p.key for p in free[0].parts}
        other = next(lk for lk in looks if lk.key not in in_first and (lk.shot.what or "").strip() and lk.quality >= 0.5 and not lk.hero_rank)
        kept, wanted, told = CM.steer_looks(looks, {"include": [other.shot.what, "a purple elephant juggling"]})
        self.assertIn(other.key, wanted)
        self.assertEqual([t["what"] for t in told], ['"a purple elephant juggling"'])
        self.assertEqual(len(kept), len(looks))

    def test_her_length_bounds_every_post(self):
        looks, tracks, talk = G.looks_for(G.load()["car-detailer"]["uploads"])
        free = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 6}, None, tracks, talk)
        self.assertTrue(any(pl.length > 9.01 for pl in free), [round(pl.length, 1) for pl in free])
        short = CM.plan_typed(looks, PB.load({}), {"min": 1, "max": 6}, None, tracks, talk, {"length": {"minS": 7, "maxS": 9}})
        self.assertTrue(short)
        self.assertTrue(all(pl.length <= 9.01 for pl in short), [round(pl.length, 1) for pl in short])


class LookAlikes(unittest.TestCase):
    def moment(self, ctype, body, hero=(50.0, 52.0)):
        m = cut.Moment("a", "montage", body[0], hero[1], [body, hero])
        m.clip_type, m.hero_asset_id = ctype, "a"
        return (m, None)

    def test_same_kind_same_ending_is_one_post(self):
        twelve = [self.moment("finished_walkthrough", (float(i * 3), float(i * 3 + 2))) for i in range(12)]
        self.assertEqual(len(cut.same_ending_once(twelve)), 1)

    def test_other_kinds_other_endings_and_talking_stay(self):
        mixed = [self.moment("finished_walkthrough", (0.0, 2.0)), self.moment("team_working", (3.0, 5.0)), self.moment("finished_walkthrough", (6.0, 8.0), (60.0, 62.0)),
                 self.moment("talk_to_camera", (9.0, 11.0)), self.moment("talk_to_camera", (12.0, 14.0))]
        self.assertEqual(len(cut.same_ending_once(mixed)), 5)


class NothingGenericWhenNoModelAnswers(unittest.TestCase):
    def test_a_connected_model_that_did_not_look_means_wait(self):
        self.assertTrue(cut.nobody_looked(True, "new", "", ["none", "local"]))
        self.assertTrue(issubclass(cut.NoModelYet, Exception) and not issubclass(cut.NoModelYet, cut.NoUsableMoments))

    def test_no_wait_when_any_model_looked_or_none_is_connected(self):
        self.assertFalse(cut.nobody_looked(True, "new", "", ["none", "vision:some-model"]))
        self.assertFalse(cut.nobody_looked(True, "new", "", ["cached"]))
        self.assertFalse(cut.nobody_looked(True, "new", "", ["local_vlm:open-model"]))
        self.assertFalse(cut.nobody_looked(False, "new", "", ["none"]))  # practice mode: nothing to wait for
        self.assertFalse(cut.nobody_looked(True, "recycle", "", ["none"]))
        self.assertFalse(cut.nobody_looked(True, "new", "again", ["none"]))
        self.assertFalse(cut.nobody_looked(True, "new", "", []))  # photos only


class UnusedVideosSayWhy(unittest.TestCase):
    def test_short_unsteady_spare_and_never_a_photo_or_a_used_video(self):
        class Lk:
            def __init__(self, asset_id, quality):
                self.asset_id, self.quality = asset_id, quality

        prepared = [({"id": x}, None, {"duration": d}, None) for x, d in (("used", 30.0), ("tiny", 4.0), ("shaky", 20.0), ("extra", 20.0), ("pic", 4.0))]
        meta = {"pic": {"photo": True}}
        looks = [Lk("shaky", 0.2), Lk("shaky", 0.4), Lk("extra", 0.9), Lk("used", 0.9)]
        clips = [{"files_used": ["used"], "hidden_reason": None}, {"files_used": ["extra"], "hidden_reason": "scored low"}]
        self.assertEqual(cut.unused_videos(prepared, meta, looks, clips), [{"asset_id": "tiny", "why": "short"}, {"asset_id": "shaky", "why": "unsteady"}, {"asset_id": "extra", "why": "spare"}])
        self.assertTrue(issubclass(cut.TooShort, cut.NoUsableMoments))


if __name__ == "__main__":
    unittest.main()
