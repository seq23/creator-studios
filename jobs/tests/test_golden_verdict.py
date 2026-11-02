"""The weekly golden set's verdict (owner ruling 2 Nov 2026, no petty validation): only the TOTAL score
falling more than ALLOWED_DROP below the baseline fails the run; a single lost check is a logged note."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import golden as G  # noqa: E402


class GoldenVerdictTest(unittest.TestCase):
    def test_lost_checks_within_the_allowed_drop_pass(self):
        # 13 of 14 checks still pass: one lost item, total 0.929 against 1.0, inside the 0.15 margin.
        self.assertFalse(G.golden_fails(round(13 / 14, 3), 1.0))
        self.assertFalse(G.golden_fails(0.85, 1.0))
        self.assertFalse(G.golden_fails(0.86, 12 / 14))

    def test_a_total_drop_past_the_margin_fails(self):
        self.assertTrue(G.golden_fails(0.84, 1.0))
        self.assertTrue(G.golden_fails(0.5, 12 / 14))
        self.assertEqual(G.ALLOWED_DROP, 0.15)


if __name__ == "__main__":
    unittest.main()
