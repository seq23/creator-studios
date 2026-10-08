"""Brand finder queries (jobs/brand_finder.py queries): built from HER niche words and themes, never
a hardcoded one. Found live on sample1, 7 Oct 2026: every studio searched hosting / tablescape /
home decor whatever its creator made. Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import brand_finder  # noqa: E402

HOST_NICHE = re.compile(r"hosting|tablescape|tableware|home decor|florist|wedding venue|party rentals|event rentals", re.I)


class NicheQueries(unittest.TestCase):
    def test_a_fitness_creator_searches_fitness(self) -> None:
        spec = {"niche_words": ["fitness", "strength"], "themes": ["Strength training: at home"], "location": "Austin, TX"}
        qs = brand_finder.queries(spec)
        self.assertTrue(qs)
        text = " ".join(q for _, q in qs)
        self.assertIsNone(HOST_NICHE.search(text), text)
        self.assertIn("fitness creator", text)
        self.assertIn("influencer agency fitness creators", text)
        self.assertIn("fitness business Austin, TX", text)
        self.assertEqual({g for g, _ in qs}, {"paying", "program", "local", "agency"})

    def test_no_niche_words_falls_back_to_her_themes_then_neutral(self) -> None:
        text = " ".join(q for _, q in brand_finder.queries({"themes": ["Budget travel: weekends away"]}))
        self.assertIn("budget travel creator", text)
        self.assertIsNone(HOST_NICHE.search(text), text)
        bare = " ".join(q for _, q in brand_finder.queries({}))
        self.assertIsNone(HOST_NICHE.search(bare), bare)

    def test_the_model_is_not_told_a_niche(self) -> None:
        self.assertIsNone(HOST_NICHE.search(brand_finder.SYSTEM), brand_finder.SYSTEM)


if __name__ == "__main__":
    unittest.main()
