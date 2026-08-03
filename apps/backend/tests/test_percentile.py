"""
Unit Tests — Percentile Ranking
=================================
Tests the percentile ranking logic inside _kpi_attainments() in scorecard.py.

What is percentile?
    Each supplier's raw value is ranked among all suppliers.
    Rank 1 = best. Formula: (N - avgRank) / (N - 1)
    Used in soft-stretch earned: max_score × attainment × (0.70 + 0.30 × percentile)

Edge cases tested:
    - N = 1 (single supplier)
    - All same values (above target / below target)
    - Tied values (midpoint rank)
    - Normal ranking (no ties)

Run:
    cd apps/backend
    python -m pytest tests/test_percentile.py -v
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scorecard import _kpi_attainments

# Use DOT config as the reference KPI for all percentile tests
DOT_KPI = {
    "id": "DOT",
    "name": "Delivery On Time",
    "pillar": "Service Level",
    "max_score": 10.0,
    "floor": 0.70,
    "target": 0.85,
    "direction": "higher",
    "unit": "percent",
}


def _make_parents(*ratios) -> dict:
    """Helper: build per_parent dict from a list of ratios."""
    return {
        f"Supplier_{i+1}": {"raw": r, "ratio": r, "applicable": True}
        for i, r in enumerate(ratios)
    }


class TestSingleSupplier:

    def test_single_supplier_gets_full_percentile(self):
        """N=1: only one supplier in population → percentile must be 1.0."""
        per_parent = _make_parents(0.80)
        result = _kpi_attainments(DOT_KPI, per_parent)
        assert result["Supplier_1"]["percentile"] == 1.0

    def test_single_supplier_above_target_gets_full_earned(self):
        """N=1, above target: attainment=1.0, percentile=1.0 → earned = max_score."""
        per_parent = _make_parents(0.90)
        result = _kpi_attainments(DOT_KPI, per_parent)
        earned = result["Supplier_1"]["earned"]
        # earned = 10.0 × 1.0 × (0.70 + 0.30 × 1.0) = 10.0
        assert abs(earned - 10.0) < 1e-6


class TestAllSameValues:

    def test_all_same_above_target_get_percentile_one(self):
        """Everyone scores the same value above target → all get percentile 1.0."""
        per_parent = _make_parents(0.90, 0.90, 0.90)
        result = _kpi_attainments(DOT_KPI, per_parent)
        for key in result:
            assert result[key]["percentile"] == 1.0, f"{key} should have percentile 1.0"

    def test_all_same_below_target_get_percentile_half(self):
        """Everyone scores the same value below target → all get percentile 0.5."""
        per_parent = _make_parents(0.75, 0.75, 0.75)
        result = _kpi_attainments(DOT_KPI, per_parent)
        for key in result:
            assert result[key]["percentile"] == 0.5, f"{key} should have percentile 0.5"


class TestNormalRanking:

    def test_three_suppliers_no_ties(self):
        """
        3 suppliers, no ties: [0.90, 0.80, 0.70]
        Rank 1 (0.90) → percentile = (3-1)/(3-1) = 1.0
        Rank 2 (0.80) → percentile = (3-2)/(3-1) = 0.5
        Rank 3 (0.70) → percentile = (3-3)/(3-1) = 0.0
        """
        per_parent = {
            "Best":   {"raw": 0.90, "ratio": 0.90, "applicable": True},
            "Middle": {"raw": 0.80, "ratio": 0.80, "applicable": True},
            "Worst":  {"raw": 0.70, "ratio": 0.70, "applicable": True},
        }
        result = _kpi_attainments(DOT_KPI, per_parent)
        assert result["Best"]["percentile"]   == 1.0
        assert result["Middle"]["percentile"] == 0.5
        assert result["Worst"]["percentile"]  == 0.0

    def test_best_supplier_gets_highest_earned(self):
        """Best supplier must always have the highest earned score."""
        per_parent = {
            "Best":   {"raw": 0.90, "ratio": 0.90, "applicable": True},
            "Middle": {"raw": 0.80, "ratio": 0.80, "applicable": True},
            "Worst":  {"raw": 0.70, "ratio": 0.70, "applicable": True},
        }
        result = _kpi_attainments(DOT_KPI, per_parent)
        assert result["Best"]["earned"] > result["Middle"]["earned"]
        assert result["Middle"]["earned"] > result["Worst"]["earned"]


class TestTiedValues:

    def test_two_tied_at_top(self):
        """
        3 suppliers, top 2 tied: [0.90, 0.90, 0.70]
        Tied group (rank 1 and 2) → avgRank = 1.5
        Tied percentile = (3 - 1.5) / (3 - 1) = 0.75
        Last → percentile = 0.0
        """
        per_parent = {
            "TiedA":  {"raw": 0.90, "ratio": 0.90, "applicable": True},
            "TiedB":  {"raw": 0.90, "ratio": 0.90, "applicable": True},
            "Last":   {"raw": 0.70, "ratio": 0.70, "applicable": True},
        }
        result = _kpi_attainments(DOT_KPI, per_parent)
        assert abs(result["TiedA"]["percentile"] - 0.75) < 1e-9
        assert abs(result["TiedB"]["percentile"] - 0.75) < 1e-9
        assert result["Last"]["percentile"] == 0.0

    def test_tied_suppliers_get_same_earned(self):
        """Two suppliers with identical raw values must get identical earned scores."""
        per_parent = {
            "TiedA": {"raw": 0.82, "ratio": 0.82, "applicable": True},
            "TiedB": {"raw": 0.82, "ratio": 0.82, "applicable": True},
        }
        result = _kpi_attainments(DOT_KPI, per_parent)
        assert result["TiedA"]["earned"] == result["TiedB"]["earned"]


class TestSoftStretchFormula:

    def test_earned_formula_correct(self):
        """
        Verify: earned = max_score × attainment × (0.70 + 0.30 × percentile)
        Single supplier (N=1): attainment at midpoint=0.5, percentile=1.0
        earned = 10 × 0.5 × (0.70 + 0.30×1.0) = 10 × 0.5 × 1.0 = 5.0
        """
        per_parent = _make_parents(0.775)  # midpoint → attainment = 0.5
        result = _kpi_attainments(DOT_KPI, per_parent)
        expected = 10.0 * 0.5 * (0.70 + 0.30 * 1.0)  # N=1 so percentile=1.0
        assert abs(result["Supplier_1"]["earned"] - expected) < 1e-6

    def test_earned_never_exceeds_max_score(self):
        """Earned score must never exceed the KPI max_score."""
        per_parent = _make_parents(1.0, 0.95, 0.90)  # all above target
        result = _kpi_attainments(DOT_KPI, per_parent)
        for key, val in result.items():
            assert val["earned"] <= DOT_KPI["max_score"], \
                f"{key} earned {val['earned']} exceeds max {DOT_KPI['max_score']}"

    def test_earned_never_negative(self):
        """Earned score must never be negative."""
        per_parent = _make_parents(0.60, 0.50, 0.30)  # all below floor
        result = _kpi_attainments(DOT_KPI, per_parent)
        for key, val in result.items():
            assert val["earned"] >= 0.0, f"{key} has negative earned: {val['earned']}"
