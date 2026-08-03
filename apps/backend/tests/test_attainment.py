"""
Unit Tests — _attainment()
===========================
Tests the attainment curve function in scorecard.py.

What is attainment?
    Converts a raw KPI value (e.g. DOT 85%) into a 0–1 score
    based on floor (minimum) and target (full-score threshold).

    higher-is-better:  raw >= target → 1.0 | raw <= floor → 0.0 | in-between → linear
    lower-is-better:   raw <= target → 1.0 | raw >= floor → 0.0 | in-between → linear

Run:
    cd apps/backend
    python -m pytest tests/test_attainment.py -v
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scorecard import _attainment


# ── Higher-is-better (DOT, SA, SC, IOT, IC, SM, ECL) ────────────────────────

class TestHigherIsBetter:

    def test_above_target_gives_full_score(self):
        """Supplier scored above target → must get 1.0 (not more)."""
        assert _attainment(0.95, 0.70, 0.85, "higher") == 1.0

    def test_exactly_at_target_gives_full_score(self):
        """Supplier hit the target exactly → must get 1.0."""
        assert _attainment(0.85, 0.70, 0.85, "higher") == 1.0

    def test_exactly_at_floor_gives_zero(self):
        """Supplier at the minimum floor → must get 0.0."""
        assert _attainment(0.70, 0.70, 0.85, "higher") == 0.0

    def test_below_floor_gives_zero(self):
        """Supplier below floor → still 0.0, never negative."""
        assert _attainment(0.50, 0.70, 0.85, "higher") == 0.0

    def test_midpoint_gives_half_score(self):
        """Midpoint between floor(0.70) and target(0.85) = 0.775 → must give 0.5."""
        result = _attainment(0.775, 0.70, 0.85, "higher")
        assert abs(result - 0.5) < 1e-9

    def test_quarter_point_gives_quarter_score(self):
        """25% of the way from floor to target → 0.25 attainment."""
        # floor=0.70, target=0.85, span=0.15 → 25% = 0.70 + 0.0375 = 0.7375
        result = _attainment(0.7375, 0.70, 0.85, "higher")
        assert abs(result - 0.25) < 1e-9

    def test_real_dot_config(self):
        """DOT config: floor=0.70, target=0.85. Supplier at 0.80."""
        # (0.80 - 0.70) / (0.85 - 0.70) = 0.10 / 0.15 = 0.6667
        result = _attainment(0.80, 0.70, 0.85, "higher")
        assert abs(result - (0.10 / 0.15)) < 1e-9

    def test_real_sa_config(self):
        """SA config: floor=0.50, target=0.80. Supplier at 0.65 (midpoint)."""
        result = _attainment(0.65, 0.50, 0.80, "higher")
        assert abs(result - 0.5) < 1e-9

    def test_real_sc_config(self):
        """SC config: floor=0.60, target=0.90. Supplier at 0.90 (exactly target)."""
        assert _attainment(0.90, 0.60, 0.90, "higher") == 1.0


# ── Lower-is-better (PDIV only) ──────────────────────────────────────────────

class TestLowerIsBetter:

    def test_below_target_gives_full_score(self):
        """PDIV: divergence below target (very low) → full score."""
        assert _attainment(0.10, 0.25, 0.199, "lower") == 1.0

    def test_exactly_at_target_gives_full_score(self):
        """PDIV: divergence exactly at target → full score."""
        assert _attainment(0.199, 0.25, 0.199, "lower") == 1.0

    def test_at_floor_gives_zero(self):
        """PDIV: divergence at floor (25%) → zero score."""
        assert _attainment(0.25, 0.25, 0.199, "lower") == 0.0

    def test_above_floor_gives_zero(self):
        """PDIV: divergence above floor (30%) → zero score, not negative."""
        assert _attainment(0.30, 0.25, 0.199, "lower") == 0.0

    def test_midpoint_gives_half_score(self):
        """PDIV midpoint between target(0.199) and floor(0.25) → 0.5."""
        mid = (0.199 + 0.25) / 2  # = 0.2245
        result = _attainment(mid, 0.25, 0.199, "lower")
        assert abs(result - 0.5) < 1e-9

    def test_in_between_gives_partial_score(self):
        """PDIV: value between target and floor → partial score between 0 and 1."""
        result = _attainment(0.22, 0.25, 0.199, "lower")
        assert 0.0 < result < 1.0
