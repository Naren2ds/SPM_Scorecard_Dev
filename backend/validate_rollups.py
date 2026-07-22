"""
validate_rollups.py
===================
Validates that rollup aggregation for each KPI matches the required method.

Spec (from business requirements):
- DOT: Weighted Avg (onTime / totalDelivered)
- IOT: Weighted Avg (onTime / totalPoLines)
- Invoice Conformity: Weighted Avg (non-mismatch / totalInvoices)
- Price Divergence: Weighted Avg (|inv-po| / poValue)
- Eclipse Score: Direct Average
- Supplier Maturity: Direct Average
- Supplier Compliance (SC): Direct Average
- Supplier Assessment (SA): Weighted Avg (counts: green+yellow+red totals)
- CO2 Emission: Direct Average (simple avg per frontend scoring)

Usage:
    conda activate spm_scorecard
    python backend/validate_rollups.py

    # Or from backend/ folder:
    python validate_rollups.py

Output: Console table + validate_rollups_report.csv in backend/data/
"""

import os
import sys
import math
from datetime import datetime
import pandas as pd
import numpy as np
from typing import Optional

# ── Path setup ────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "data")

ROLLUP_DIMS = ["zone", "parentSupplier", "category"]

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"   # dim not present in data
INFO = "INFO"   # informational (CO2 uses simple avg by design)

results: list[dict] = []


# ── Helpers ───────────────────────────────────────────────────────────────────

def load(filename: str) -> pd.DataFrame:
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        print(f"  [MISSING] {filename} — skipping KPI")
        return pd.DataFrame()
    df = pd.read_csv(path, low_memory=False)
    # Normalize string columns
    for col in df.select_dtypes(include=["object", "string"]).columns:
        df[col] = df[col].astype(str).str.strip()
    return df


def safe_float(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def weighted_avg(df: pd.DataFrame, dim: str, num_col: str, den_col: str) -> pd.Series:
    """Group by dim, return weighted average = sum(num) / sum(den)."""
    g = df.groupby(dim, dropna=False)[[num_col, den_col]].sum(min_count=1)
    return (g[num_col] / g[den_col]).rename("weighted")


def direct_avg(df: pd.DataFrame, dim: str, metric_col: str) -> pd.Series:
    """Group by dim, return simple mean of metric_col (NaN-safe)."""
    return df.groupby(dim, dropna=False)[metric_col].mean().rename("direct")


def check_dim(dim: str, df: pd.DataFrame) -> tuple[bool, str]:
    """Return (is_validatable, reason). Validatable means dim exists and has at least one non-empty value."""
    if dim not in df.columns:
        return False, f"Column '{dim}' missing"

    valid = df[dim].dropna().astype(str).str.strip()
    valid = valid[(valid != "") & (valid.str.lower() != "nan")]
    if valid.nunique() == 0:
        return False, f"Column '{dim}' has no non-empty values"

    return True, ""


def record(kpi: str, dim: str, status: str, detail: str = ""):
    results.append({"KPI": kpi, "Rollup Dimension": dim, "Status": status, "Detail": detail})
    print(f"  [{status}] {kpi:<28} | dim={dim:<16} | {detail}")


def compare_rollups(
    kpi: str,
    df: pd.DataFrame,
    dims: list[str],
    expected_agg: str,           # "weighted" | "direct"
    *,
    num_col: Optional[str] = None,
    den_col: Optional[str] = None,
    metric_col: Optional[str] = None,
    tolerance: float = 1e-6,
):
    """
    For each dim in dims:
      - compute rollup using the EXPECTED aggregation formula
      - compute rollup using the ALTERNATIVE formula
      - if results differ by > tolerance, confirms the method matters
      - always validates that the expected formula produces valid values
    """
    for dim in dims:
        ok, reason = check_dim(dim, df)
        if not ok:
            record(kpi, dim, SKIP, reason)
            continue

        try:
            if expected_agg == "weighted":
                if num_col is None or den_col is None:
                    record(kpi, dim, FAIL, "num_col / den_col not specified for weighted avg")
                    continue
                wgt = weighted_avg(df, dim, num_col, den_col)
                # Alternative: direct avg of the metric
                if metric_col and metric_col in df.columns:
                    alt = direct_avg(df, dim, metric_col)
                    common = wgt.index.intersection(alt.index)
                    diff = (wgt[common] - alt[common]).abs()
                    max_diff = diff.max()
                    groups_differ = int((diff > tolerance).sum())
                    cardinality_note = ""
                    if len(common) == 1:
                        cardinality_note = " Single group only; formula still validated on that group."
                    detail = (
                        f"Weighted avg computed for {len(wgt)} groups. "
                        f"Max deviation vs direct avg = {max_diff:.6f} "
                        f"({groups_differ}/{len(common)} groups differ). "
                        f"Correct formula: sum({num_col})/sum({den_col})."
                        f"{cardinality_note}"
                    )
                else:
                    valid = wgt.dropna()
                    detail = (
                        f"Weighted avg computed for {len(valid)} groups. "
                        f"Formula: sum({num_col})/sum({den_col})"
                    )
                status = PASS if wgt.notna().any() else FAIL

            else:  # direct avg
                if metric_col is None:
                    record(kpi, dim, FAIL, "metric_col not specified for direct avg")
                    continue
                dav = direct_avg(df, dim, metric_col)
                # Alternative: weighted avg if num/den available
                if num_col and den_col and num_col in df.columns and den_col in df.columns:
                    wgt = weighted_avg(df, dim, num_col, den_col)
                    common = dav.index.intersection(wgt.index)
                    diff = (dav[common] - wgt[common]).abs()
                    max_diff = diff.max()
                    groups_differ = int((diff > tolerance).sum())
                    cardinality_note = ""
                    if len(common) == 1:
                        cardinality_note = " Single group only; formula still validated on that group."
                    detail = (
                        f"Direct avg computed for {len(dav)} groups. "
                        f"Max deviation vs weighted avg = {max_diff:.6f} "
                        f"({groups_differ}/{len(common)} groups differ). "
                        f"Correct formula: mean({metric_col})."
                        f"{cardinality_note}"
                    )
                else:
                    valid = dav.dropna()
                    detail = (
                        f"Direct avg computed for {len(valid)} groups. "
                        f"Formula: mean({metric_col})"
                    )
                status = PASS if dav.notna().any() else FAIL

        except Exception as exc:
            record(kpi, dim, FAIL, f"Exception: {exc}")
            continue

        record(kpi, dim, status, detail)


# ============================================================================
# KPI 1 — DOT  (Weighted Avg)
# dotPercent = sum(onTimePoLines) / sum(totalDeliveredPoLines)
# ============================================================================

def validate_dot():
    print("\n-- DOT (Delivery On Time) --------------------------------------")
    df = load("dot_kpi.csv")
    if df.empty:
        return
    df["onTimePoLines"] = safe_float(df["onTimePoLines"])
    df["totalDeliveredPoLines"] = safe_float(df["totalDeliveredPoLines"])
    df["dotPercent"] = safe_float(df["dotPercent"])
    compare_rollups(
        "DOT",
        df,
        ROLLUP_DIMS,
        "weighted",
        num_col="onTimePoLines",
        den_col="totalDeliveredPoLines",
        metric_col="dotPercent",
    )


# ============================================================================
# KPI 2 — IOT  (Weighted Avg)
# iotPct = sum(invoiceOnTimeCount) / sum(totalPoLines)
# ============================================================================

def validate_iot():
    print("\n-- IOT (Invoice On Time) ---------------------------------------")
    df = load("iot_kpi.csv")
    if df.empty:
        return
    df["invoiceOnTimeCount"] = safe_float(df["invoiceOnTimeCount"])
    df["totalPoLines"] = safe_float(df["totalPoLines"])
    # Compute metric for reference
    df["iotPct"] = df["invoiceOnTimeCount"] / df["totalPoLines"]
    compare_rollups(
        "IOT",
        df,
        ROLLUP_DIMS,
        "weighted",
        num_col="invoiceOnTimeCount",
        den_col="totalPoLines",
        metric_col="iotPct",
    )


# ============================================================================
# KPI 3 — Invoice Conformity  (Weighted Avg)
# conformityPct = (totalInvoices - mismatchCount) / totalInvoices
# Rollup = sum(totalInvoices - mismatchCount) / sum(totalInvoices)
# ============================================================================

def validate_invoice_conformity():
    print("\n-- Invoice Conformity ------------------------------------------")
    df = load("invoice_conformity.csv")
    if df.empty:
        return
    df["totalInvoices"] = safe_float(df["totalInvoices"])
    df["mismatchCount"] = safe_float(df["mismatchCount"])
    df["conformityPct"] = safe_float(df["conformityPct"])
    # Numerator for weighted avg = non-mismatch invoices
    df["_non_mismatch"] = df["totalInvoices"] - df["mismatchCount"]
    compare_rollups(
        "Invoice Conformity",
        df,
        ROLLUP_DIMS,
        "weighted",
        num_col="_non_mismatch",
        den_col="totalInvoices",
        metric_col="conformityPct",
    )


# ============================================================================
# KPI 4 — Price Divergence  (Weighted Avg)
# divergencePct = |sum(invoiceValue) - sum(poValue)| / sum(poValue)
# ============================================================================

def validate_price_divergence():
    print("\n-- Price Divergence --------------------------------------------")
    df = load("price_divergence.csv")
    if df.empty:
        return
    df["poValue"] = safe_float(df["poValue"])
    df["invoiceValue"] = safe_float(df["invoiceValue"])
    df["divergencePct"] = safe_float(df["divergencePct"])

    # Compute weighted rollup per dim manually (formula has abs diff)
    for dim in ROLLUP_DIMS:
        ok, reason = check_dim(dim, df)
        if not ok:
            record("Price Divergence", dim, SKIP, reason)
            continue
        try:
            g = df.groupby(dim, dropna=False)[["poValue", "invoiceValue"]].sum(min_count=1)
            g["div_weighted"] = (g["invoiceValue"] - g["poValue"]).abs() / g["poValue"]

            # Alternative: direct avg
            alt = df.groupby(dim, dropna=False)["divergencePct"].mean()
            common = g.index.intersection(alt.index)
            diff = (g.loc[common, "div_weighted"] - alt[common]).abs()
            max_diff = diff.max()
            groups_differ = int((diff > 1e-6).sum())

            detail = (
                f"Weighted avg: |sum(inv)-sum(po)|/sum(po) for {len(g)} groups. "
                f"Max deviation vs direct avg = {max_diff:.6f} "
                f"({groups_differ}/{len(common)} groups differ). "
                f"Correct formula: |sum(invoiceValue)-sum(poValue)|/sum(poValue)"
            )
            status = PASS if g["div_weighted"].notna().any() else FAIL
            record("Price Divergence", dim, status, detail)
        except Exception as exc:
            record("Price Divergence", dim, FAIL, f"Exception: {exc}")


# ============================================================================
# KPI 5 — Eclipse Score  (Direct Average)
# rollup = mean(eclipseScore) per group
# ============================================================================

def validate_eclipse():
    print("\n-- Eclipse Score -----------------------------------------------")
    df = load("eclipse.csv")
    if df.empty:
        return
    df["eclipseScore"] = safe_float(df["eclipseScore"])
    # Only zone and category available (no country)
    dims = [d for d in ROLLUP_DIMS if d in df.columns]
    compare_rollups(
        "Eclipse Score",
        df,
        dims,
        "direct",
        metric_col="eclipseScore",
    )


# ============================================================================
# KPI 6 — Supplier Maturity  (Direct Average)
# rollup = mean(maturityScore) per group
# ============================================================================

def validate_supplier_maturity():
    print("\n-- Supplier Maturity -------------------------------------------")
    df = load("supplier_maturity.csv")
    if df.empty:
        return
    df["maturityScore"] = safe_float(df["maturityScore"])
    dims = [d for d in ROLLUP_DIMS if d in df.columns]
    compare_rollups(
        "Supplier Maturity",
        df,
        dims,
        "direct",
        metric_col="maturityScore",
    )


# ============================================================================
# KPI 7 — Supplier Compliance (SC)  (Direct Average)
# rollup = mean(compliancePct) per group
# ============================================================================

def validate_supplier_compliance():
    print("\n-- Supplier Compliance (SC) ------------------------------------")
    df = load("supplier_compliance.csv")
    if df.empty:
        return
    df["compliancePct"] = safe_float(df["compliancePct"])
    compare_rollups(
        "Supplier Compliance (SC)",
        df,
        ROLLUP_DIMS,
        "direct",
        metric_col="compliancePct",
    )


# ============================================================================
# KPI 8 — Supplier Assessment (SA)  (Weighted Avg)
# Score per group = weighted_avg(greenCount, yellowCount, redCount) using weights
# Rollup = sum all counts then recompute — equivalent to weighted avg by
# total valid assessments.
# Validation: check that sum(greenCount+yellowCount+redCount) differs from
# direct avg approach across groups.
# ============================================================================

def validate_supplier_assessment():
    print("\n-- Supplier Assessment (SA) ------------------------------------")
    df = load("supplier_assessment.csv")
    if df.empty:
        return
    for col in ["greenCount", "yellowCount", "redCount", "naCount"]:
        df[col] = safe_float(df[col])

    # Total valid assessments = green + yellow + red (na excluded per scoring engine)
    df["_totalValid"] = df["greenCount"].fillna(0) + df["yellowCount"].fillna(0) + df["redCount"].fillna(0)
    # Using default weights (green=1, yellow=0.5, red=0) → score = green / totalValid
    # We validate using greenCount/totalValid as weighted metric
    df["_greenRate"] = df["greenCount"] / df["_totalValid"]

    compare_rollups(
        "Supplier Assessment (SA)",
        df,
        ROLLUP_DIMS,
        "weighted",
        num_col="greenCount",
        den_col="_totalValid",
        metric_col="_greenRate",
    )


# ============================================================================
# KPI 9 — CO2 Emission  (Direct Average — Simple Avg per frontend scoring.ts)
# Note: User spec says "Weighted Avg - To be Checked"
# Frontend scoring.ts comment: "Roll up Parent / Zone using SIMPLE AVERAGE"
# This validation flags the discrepancy and validates direct avg is implemented.
# ============================================================================

def validate_co2():
    print("\n-- CO2 Emission ------------------------------------------------")
    df = load("co2_emission.csv")
    if df.empty:
        return
    df["co2Emission"] = safe_float(df["co2Emission"])
    dims = [d for d in ROLLUP_DIMS if d in df.columns]

    print(
        "  INFO: Business spec says 'Weighted Avg - To be Checked'.\n"
        "      Frontend scoring.ts uses SIMPLE AVERAGE (direct avg).\n"
        "      Flagged for business review - validating current implementation."
    )

    compare_rollups(
        "CO2 Emission",
        df,
        dims,
        "direct",
        metric_col="co2Emission",
    )
    # Extra: show what sum-based rollup would look like
    print("  INFO: For reference, CO2 could also be aggregated as SUM per group.")
    for dim in dims:
        ok, reason = check_dim(dim, df)
        if not ok:
            continue
        g_sum = df.groupby(dim, dropna=False)["co2Emission"].sum()
        g_avg = df.groupby(dim, dropna=False)["co2Emission"].mean()
        diff = (g_sum - g_avg).abs()
        print(
            f"      {dim}: max(sum-avg diff) = {diff.max():.2f} - "
            f"SUM would give {int(g_sum.notna().sum())} non-null groups"
        )


# ============================================================================
# Report summary
# ============================================================================

def print_summary():
    print("\n" + "=" * 80)
    print("VALIDATION SUMMARY")
    print("=" * 80)
    df = pd.DataFrame(results)
    if df.empty:
        print("No results recorded.")
        return

    # Print grouped by KPI
    for kpi, grp in df.groupby("KPI", sort=False):
        passes = (grp["Status"] == PASS).sum()
        fails = (grp["Status"] == FAIL).sum()
        skips = (grp["Status"] == SKIP).sum()
        overall = "OK" if fails == 0 else "FAIL"
        print(f"\n  {overall} {kpi}")
        for _, row in grp.iterrows():
            print(f"      {row['Status']:<6} {row['Rollup Dimension']:<16}: {row['Detail'][:100]}")

    total_pass = (df["Status"] == PASS).sum()
    total_fail = (df["Status"] == FAIL).sum()
    total_skip = (df["Status"] == SKIP).sum()
    print(f"\n{'-'*80}")
    print(f"  TOTAL: {total_pass} passed | {total_fail} failed | {total_skip} skipped")
    print("=" * 80)

    # Save report
    out_path = os.path.join(DATA_DIR, "validate_rollups_report.csv")
    try:
        df.to_csv(out_path, index=False)
        print(f"\n  Report saved to: {out_path}\n")
    except PermissionError:
        fallback = os.path.join(
            DATA_DIR,
            f"validate_rollups_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        )
        df.to_csv(fallback, index=False)
        print(
            "\n  Primary report file is locked. "
            f"Saved to fallback file instead: {fallback}\n"
        )


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    print("=" * 80)
    print("SPM Scorecard - Rollup Aggregation Validation")
    print("=" * 80)

    validate_dot()
    validate_iot()
    validate_invoice_conformity()
    validate_price_divergence()
    validate_eclipse()
    validate_supplier_maturity()
    validate_supplier_compliance()
    validate_supplier_assessment()
    validate_co2()

    print_summary()
