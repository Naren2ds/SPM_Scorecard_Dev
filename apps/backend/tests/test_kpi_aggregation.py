"""
Unit Tests — KPI Aggregation Formulas
========================================
Tests _aggregate_kpi() for each KPI type in scorecard.py.

What is aggregation?
    Multiple raw CSV rows per supplier are collapsed into one ratio.
    e.g. ARDAGH has 50 DOT rows → aggregated into one DOT ratio (0.847).
    That ratio then goes into the attainment curve.

Formulas verified:
    DOT  — adjusted denominator: onTime / (total + 0.99×delayed + 0.10×early)
    SA   — green=1.0, yellow=0.5, red=0 weighted health score
    SM   — maturityScore normalized to 0–1 (÷100 if given as 0–100)
    PDIV — weighted aggregate: Σ|inv-po| / Σpo (not per-row average)
    IC   — (totalInvoices - mismatchCount) / totalInvoices

Run:
    cd apps/backend
    python -m pytest tests/test_kpi_aggregation.py -v
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scorecard import KPI_CONFIGS, _aggregate_kpi

# ── KPI config lookup helper ─────────────────────────────────────────────────
KPI_MAP = {k["id"]: k for k in KPI_CONFIGS}


# ── DOT — Adjusted Denominator ───────────────────────────────────────────────

class TestDotAggregation:

    def test_basic_dot_ratio(self):
        """
        onTime=80, total=100, delayed=0, early=0
        Expected: 80 / 100 = 0.80
        """
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "onTimePoLines": "80", "totalDeliveredPoLines": "100",
                 "x1DelayedOver30Days": "0", "x2EarlyOver30Days": "0"}]
        result = _aggregate_kpi(KPI_MAP["DOT"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.80) < 1e-9

    def test_dot_adjusted_denominator_with_delays(self):
        """
        onTime=80, total=100, delayed=10, early=5
        Adjusted denominator: 100 + 0.99×10 + 0.10×5 = 100 + 9.9 + 0.5 = 110.4
        Expected: 80 / 110.4 = 0.7246...
        """
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "onTimePoLines": "80", "totalDeliveredPoLines": "100",
                 "x1DelayedOver30Days": "10", "x2EarlyOver30Days": "5"}]
        result = _aggregate_kpi(KPI_MAP["DOT"], rows, None, None, None)
        expected = 80 / (100 + 0.99 * 10 + 0.10 * 5)
        assert abs(result["A"]["ratio"] - expected) < 1e-9

    def test_dot_not_applicable_rows_excluded(self):
        """Rows marked Not Applicable must be completely excluded."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Not Applicable",
                 "onTimePoLines": "80", "totalDeliveredPoLines": "100",
                 "x1DelayedOver30Days": "0", "x2EarlyOver30Days": "0"}]
        result = _aggregate_kpi(KPI_MAP["DOT"], rows, None, None, None)
        assert "A" not in result

    def test_dot_multiple_rows_aggregated(self):
        """
        Two rows for same parent → numerators and denominators summed.
        Row1: onTime=80, total=100, delayed=0, early=0
        Row2: onTime=40, total=50,  delayed=0, early=0
        Expected: (80+40) / (100+50) = 120/150 = 0.80
        """
        rows = [
            {"parentSupplier": "A", "kpiApplicability": "Applicable",
             "onTimePoLines": "80", "totalDeliveredPoLines": "100",
             "x1DelayedOver30Days": "0", "x2EarlyOver30Days": "0"},
            {"parentSupplier": "A", "kpiApplicability": "Applicable",
             "onTimePoLines": "40", "totalDeliveredPoLines": "50",
             "x1DelayedOver30Days": "0", "x2EarlyOver30Days": "0"},
        ]
        result = _aggregate_kpi(KPI_MAP["DOT"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - (120 / 150)) < 1e-9


# ── SA — Green/Yellow/Red Weighting ─────────────────────────────────────────

class TestSaAggregation:

    def test_all_green_gives_full_score(self):
        """All green assessments → ratio = 1.0."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "greenCount": "10", "yellowCount": "0", "redCount": "0"}]
        result = _aggregate_kpi(KPI_MAP["SA"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 1.0) < 1e-9

    def test_all_red_gives_zero(self):
        """All red assessments → ratio = 0.0."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "greenCount": "0", "yellowCount": "0", "redCount": "5"}]
        result = _aggregate_kpi(KPI_MAP["SA"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.0) < 1e-9

    def test_mixed_green_yellow_red(self):
        """
        green=6, yellow=2, red=2 (total=10)
        Expected: (6×1.0 + 2×0.5 + 2×0) / 10 = 7/10 = 0.70
        """
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "greenCount": "6", "yellowCount": "2", "redCount": "2"}]
        result = _aggregate_kpi(KPI_MAP["SA"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.70) < 1e-9

    def test_yellow_weight_is_half(self):
        """
        Only yellow assessments → ratio = 0.5 (yellow = 0.5 weight).
        green=0, yellow=4, red=0 → (0 + 4×0.5 + 0) / 4 = 0.5
        """
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "greenCount": "0", "yellowCount": "4", "redCount": "0"}]
        result = _aggregate_kpi(KPI_MAP["SA"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.5) < 1e-9

    def test_zero_total_row_excluded(self):
        """Row with green+yellow+red=0 must be excluded (no valid assessments)."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "greenCount": "0", "yellowCount": "0", "redCount": "0"}]
        result = _aggregate_kpi(KPI_MAP["SA"], rows, None, None, None)
        assert "A" not in result


# ── SM — Maturity Score Normalization ────────────────────────────────────────

class TestSmAggregation:

    def test_score_on_0_to_100_scale_normalized(self):
        """maturityScore=75 (0-100 scale) → must be normalized to 0.75."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "maturityScore": "75"}]
        result = _aggregate_kpi(KPI_MAP["SM"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.75) < 1e-9

    def test_score_already_on_0_to_1_scale_unchanged(self):
        """maturityScore=0.75 (already 0-1) → must stay 0.75 (no extra ÷100)."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "maturityScore": "0.75"}]
        result = _aggregate_kpi(KPI_MAP["SM"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.75) < 1e-9

    def test_score_100_gives_ratio_1(self):
        """maturityScore=100 → normalized to 1.0 (perfect score)."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "maturityScore": "100"}]
        result = _aggregate_kpi(KPI_MAP["SM"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 1.0) < 1e-9

    def test_multiple_rows_averaged(self):
        """
        Two SM rows: 60 and 80 (0-100 scale) → normalized avg = (0.60+0.80)/2 = 0.70
        """
        rows = [
            {"parentSupplier": "A", "kpiApplicability": "Applicable", "maturityScore": "60"},
            {"parentSupplier": "A", "kpiApplicability": "Applicable", "maturityScore": "80"},
        ]
        result = _aggregate_kpi(KPI_MAP["SM"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.70) < 1e-9


# ── PDIV — Weighted Aggregate (not per-row average) ─────────────────────────

class TestPdivAggregation:

    def test_single_row_divergence(self):
        """
        invoiceValue=105, poValue=100
        Expected: |105-100| / 100 = 5/100 = 0.05
        """
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "invoiceValue": "105", "poValue": "100"}]
        result = _aggregate_kpi(KPI_MAP["PDIV"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.05) < 1e-9

    def test_two_rows_weighted_not_averaged(self):
        """
        Row1: inv=105, po=100  → divergence=5
        Row2: inv=112, po=100  → divergence=12
        Expected: (5+12) / (100+100) = 17/200 = 0.085
        NOT simple average: (0.05+0.12)/2 = 0.085 (same here but different for unequal po)
        """
        rows = [
            {"parentSupplier": "A", "kpiApplicability": "Applicable",
             "invoiceValue": "105", "poValue": "100"},
            {"parentSupplier": "A", "kpiApplicability": "Applicable",
             "invoiceValue": "112", "poValue": "100"},
        ]
        result = _aggregate_kpi(KPI_MAP["PDIV"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - (17 / 200)) < 1e-9

    def test_pdiv_weighted_vs_average_differ_on_unequal_po(self):
        """
        Verify weighted aggregate differs from simple average when PO values are unequal.
        Row1: inv=110, po=100  → div=10 (10%)
        Row2: inv=205, po=200  → div=5  (2.5%)
        Weighted: (10+5)/(100+200) = 15/300 = 0.05
        Simple avg: (0.10+0.025)/2 = 0.0625  ← different!
        """
        rows = [
            {"parentSupplier": "A", "kpiApplicability": "Applicable",
             "invoiceValue": "110", "poValue": "100"},
            {"parentSupplier": "A", "kpiApplicability": "Applicable",
             "invoiceValue": "205", "poValue": "200"},
        ]
        result = _aggregate_kpi(KPI_MAP["PDIV"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.05) < 1e-9  # weighted = 0.05
        assert abs(result["A"]["ratio"] - 0.0625) > 1e-6  # NOT simple average

    def test_zero_divergence_gives_zero(self):
        """Invoice = PO → no divergence → ratio = 0.0."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "invoiceValue": "100", "poValue": "100"}]
        result = _aggregate_kpi(KPI_MAP["PDIV"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.0) < 1e-9


# ── IC — Invoice Conformity ───────────────────────────────────────────────────

class TestIcAggregation:

    def test_no_mismatches_gives_full_conformity(self):
        """totalInvoices=10, mismatchCount=0 → conformity = 1.0."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "totalInvoices": "10", "mismatchCount": "0"}]
        result = _aggregate_kpi(KPI_MAP["IC"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 1.0) < 1e-9

    def test_all_mismatches_gives_zero(self):
        """totalInvoices=10, mismatchCount=10 → conformity = 0.0."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "totalInvoices": "10", "mismatchCount": "10"}]
        result = _aggregate_kpi(KPI_MAP["IC"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.0) < 1e-9

    def test_partial_mismatches(self):
        """totalInvoices=10, mismatchCount=3 → conformity = 7/10 = 0.70."""
        rows = [{"parentSupplier": "A", "kpiApplicability": "Applicable",
                 "totalInvoices": "10", "mismatchCount": "3"}]
        result = _aggregate_kpi(KPI_MAP["IC"], rows, None, None, None)
        assert abs(result["A"]["ratio"] - 0.70) < 1e-9
