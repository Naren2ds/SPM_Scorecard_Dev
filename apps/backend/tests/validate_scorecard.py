"""
Automated Scorecard Validation
================================
Validates earned scores for every parent supplier by independently recomputing:
  1. KPI raw ratios (from CSV rows)
  2. Attainment values
  3. Percentile / soft-stretch earned points
  4. Pillar Score %
  5. Normalized Score

Compares every value against the output of compute_scorecard() and reports
any discrepancy above TOLERANCE (default 0.001).

Usage
-----
    cd apps/backend
    python validate_scorecard.py

    # With optional filters (same as the UI slicers)
    python validate_scorecard.py --zones EUR --categories "Raw Materials"

Output
------
    data/scorecard_validation_report.csv   — full row-level detail
    Prints a pass/fail summary to the terminal.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

# ── Make sure scorecard.py is importable from apps/backend ─────────────────
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scorecard import (
    KPI_CONFIGS,
    PILLAR_WEIGHTS,
    _aggregate_kpi,
    _attainment,
    _is_applicable,
    _kpi_attainments,
    _rollup_key,
    _to_num,
    compute_scorecard,
)

# ── Paths ────────────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
REPORT_PATH = DATA_DIR / "scorecard_validation_report.csv"
CONFIG_OVERRIDES_PATH = DATA_DIR / "kpi_config_overrides.json"

TOLERANCE       = 0.001   # max allowed absolute difference for KPI-level fields
TOLERANCE_SCORE = 0.005   # max allowed diff for normalized score (server rounds to 2 dp)


# ── CSV loaders (mirrors server.py _load_csv) ────────────────────────────────

def _load_csv(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _load_all_csvs() -> dict[str, list[dict]]:
    return {
        "dot_kpi":             _load_csv(DATA_DIR / "dot_kpi.csv"),
        "iot_kpi":             _load_csv(DATA_DIR / "iot_kpi.csv"),
        "supplier_assessment": _load_csv(DATA_DIR / "supplier_assessment.csv"),
        "supplier_compliance": _load_csv(DATA_DIR / "supplier_compliance.csv"),
        "supplier_maturity":   _load_csv(DATA_DIR / "supplier_maturity.csv"),
        "co2_emission":        _load_csv(DATA_DIR / "co2_emission.csv"),
        "eclipse":             _load_csv(DATA_DIR / "eclipse.csv"),
        "invoice_conformity":  _load_csv(DATA_DIR / "invoice_conformity.csv"),
        "price_divergence":    _load_csv(DATA_DIR / "price_divergence.csv"),
    }


def _apply_config_overrides() -> None:
    """Apply persisted floor/target/max_score overrides to KPI_CONFIGS in-place."""
    if not CONFIG_OVERRIDES_PATH.exists():
        return
    try:
        overrides: dict = json.loads(CONFIG_OVERRIDES_PATH.read_text(encoding="utf-8"))
        for kpi in KPI_CONFIGS:
            ov = overrides.get(kpi["id"])
            if not ov:
                continue
            if ov.get("floor")     is not None:
                kpi["floor"]     = float(ov["floor"])
            if ov.get("target")    is not None:
                kpi["target"]    = float(ov["target"])
            if ov.get("max_score") is not None:
                kpi["max_score"] = float(ov["max_score"])
    except Exception as exc:
        print(f"[WARN] Could not load config overrides: {exc}")


# ── Independent recomputation ────────────────────────────────────────────────

def recompute_from_scratch(
    cache: dict[str, list[dict]],
    zones: set[str] | None,
    categories: set[str] | None,
    parents: set[str] | None,
) -> dict[str, Any]:
    """
    Independently recompute the full scorecard using scorecard.py helpers
    but called explicitly here so the validation path is distinct from the
    server path. Returns structure mirrors compute_scorecard() output.
    """
    kpi_results: dict[str, dict[str, dict]] = {}
    for kpi in KPI_CONFIGS:
        rows = cache.get(kpi["cache_key"], []) or []
        agg = _aggregate_kpi(kpi, rows, zones, categories, parents)

        individual_vals: list[float] | None = None
        if kpi["direction"] == "quartile":
            individual_vals = []
            for r in rows:
                if zones and str(r.get("zone", "")).strip() not in zones:
                    continue
                if categories and str(r.get("category", "")).strip() not in categories:
                    continue
                if parents and _rollup_key(r) not in parents:
                    continue
                if not _is_applicable(r.get("kpiApplicability")):
                    continue
                v = _to_num(r.get("co2Emission"))
                if v is not None:
                    individual_vals.append(v)

        scored = _kpi_attainments(kpi, agg, individual_values=individual_vals)
        kpi_results[kpi["id"]] = scored

    parent_universe: set[str] = set()
    for scored in kpi_results.values():
        parent_universe.update(scored.keys())

    total_expected_weight = sum(k["max_score"] for k in KPI_CONFIGS)
    kpis_by_pillar: dict[str, list[dict]] = {}
    for k in KPI_CONFIGS:
        kpis_by_pillar.setdefault(k["pillar"], []).append(k)

    result: dict[str, dict] = {}
    for parent in parent_universe:
        weighted_sum = 0.0
        applicable_pillar_weight = 0.0
        available_kpi_weight = 0.0
        kpi_details: list[dict] = []

        for pillar_name, pillar_weight in PILLAR_WEIGHTS.items():
            earned_sum = 0.0
            max_sum = 0.0
            for kpi in kpis_by_pillar.get(pillar_name, []):
                scored = kpi_results[kpi["id"]].get(parent)
                if scored is None:
                    kpi_details.append({
                        "kpi_id": kpi["id"],
                        "pillar": pillar_name,
                        "raw": None,
                        "attainment": None,
                        "percentile": None,
                        "earned": None,
                        "max_score": kpi["max_score"],
                        "applicable": False,
                    })
                    continue
                kpi_details.append({
                    "kpi_id": kpi["id"],
                    "pillar": pillar_name,
                    "raw": scored["raw"],
                    "attainment": scored["attainment"],
                    "percentile": scored.get("percentile"),
                    "earned": scored["earned"],
                    "max_score": kpi["max_score"],
                    "applicable": True,
                })
                earned_sum += scored["earned"]
                max_sum += kpi["max_score"]
                available_kpi_weight += kpi["max_score"]

            if max_sum > 0:
                pillar_pct = earned_sum / max_sum
                weighted_sum += pillar_pct * pillar_weight
                applicable_pillar_weight += pillar_weight

        normalized = (
            (weighted_sum / applicable_pillar_weight) * 100.0
            if applicable_pillar_weight > 0 else 0.0
        )
        coverage = (
            available_kpi_weight / total_expected_weight
            if total_expected_weight > 0 else 0.0
        )

        result[parent] = {
            "normalized_score": round(normalized, 6),
            "coverage_pct": round(coverage, 6),
            "coverage_adjusted_score": round(normalized * coverage, 6),
            "kpi_details": kpi_details,
        }

    return result


# ── Comparison logic ─────────────────────────────────────────────────────────

def _diff(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return abs(a - b)


def _flag(diff_val: float | None) -> str:
    if diff_val is None:
        return "N/A"
    return "FAIL" if diff_val > TOLERANCE else "PASS"


def run_validation(
    zones: list[str] | None = None,
    categories: list[str] | None = None,
    parents: list[str] | None = None,
) -> bool:
    """
    Run full automated validation.
    Returns True if ALL checks pass, False if any FAIL.
    """
    _apply_config_overrides()
    cache = _load_all_csvs()

    zones_set    = set(zones)    if zones    else None
    cats_set     = set(categories) if categories else None
    parents_set  = set(parents)  if parents  else None

    print("\n" + "=" * 70)
    print("  SPM SCORECARD AUTOMATED VALIDATION")
    print("=" * 70)
    print(f"  Tolerance   : {TOLERANCE}")
    print(f"  Zones       : {zones or 'ALL'}")
    print(f"  Categories  : {categories or 'ALL'}")
    print(f"  Parents     : {parents or 'ALL'}")
    print("=" * 70 + "\n")

    # ── 1. Run compute_scorecard (server path) ───────────────────────────────
    print("[1/3] Running compute_scorecard() ...")
    server_result = compute_scorecard(
        cache,
        zones=zones,
        categories=categories,
        parents=parents,
        include_kpi_breakdown=True,
    )
    server_by_parent: dict[str, dict] = {
        s["parentSupplier"]: s for s in server_result["scorecards"]
    }

    # ── 2. Independent recomputation ────────────────────────────────────────
    print("[2/3] Running independent recomputation ...")
    recomputed = recompute_from_scratch(cache, zones_set, cats_set, parents_set)

    # ── 3. Compare ───────────────────────────────────────────────────────────
    print("[3/3] Comparing results ...\n")

    report_rows: list[dict] = []
    all_pass = True

    all_parents = sorted(set(server_by_parent.keys()) | set(recomputed.keys()))

    if not all_parents:
        print("  [WARN] No parent suppliers found — check data files and filters.")
        return False

    kpi_id_list = [k["id"] for k in KPI_CONFIGS]

    for parent in all_parents:
        srv = server_by_parent.get(parent)
        rec = recomputed.get(parent)

        # ── Normalized score comparison ──────────────────────────────────
        # Server rounds to 2 dp before returning; compare at that precision.
        srv_norm = round(srv["normalized_score"], 6) if srv else None
        rec_norm = round(rec["normalized_score"], 2) if rec else None  # match server rounding
        norm_diff = _diff(srv_norm, rec_norm)
        norm_flag = "FAIL" if (norm_diff is not None and norm_diff > TOLERANCE_SCORE) else _flag(norm_diff)

        if norm_flag == "FAIL":
            all_pass = False
            print(f"  [FAIL] {parent}")
            print(f"         Normalized score: server={srv_norm:.4f}  recomputed={rec_norm:.4f}  diff={norm_diff:.6f}")

        # ── Coverage comparison ──────────────────────────────────────────
        srv_cov = round(srv["coverage_pct"], 6) if srv else None
        rec_cov = round(rec["coverage_pct"], 4) if rec else None  # server rounds to 4 dp
        cov_diff = _diff(srv_cov, rec_cov)
        cov_flag = _flag(cov_diff)
        if cov_flag == "FAIL":
            all_pass = False
            print(f"  [FAIL] {parent} — Coverage pct: server={srv_cov:.4f}  recomputed={rec_cov:.4f}  diff={cov_diff:.6f}")

        # ── Per-KPI comparison ───────────────────────────────────────────
        srv_kpi_map: dict[str, dict] = {}
        if srv:
            for pillar in srv.get("pillars", []):
                for krow in pillar.get("kpis", []):
                    srv_kpi_map[krow["id"]] = krow

        rec_kpi_map: dict[str, dict] = {}
        if rec:
            for krow in rec.get("kpi_details", []):
                rec_kpi_map[krow["kpi_id"]] = krow

        for kpi_id in kpi_id_list:
            sk = srv_kpi_map.get(kpi_id, {})
            rk = rec_kpi_map.get(kpi_id, {})

            srv_raw  = _to_num(sk.get("raw"))
            rec_raw  = _to_num(rk.get("raw"))
            srv_att  = _to_num(sk.get("attainment"))
            rec_att  = _to_num(rk.get("attainment"))
            srv_pct  = _to_num(sk.get("percentile"))
            rec_pct  = _to_num(rk.get("percentile"))
            srv_earn = _to_num(sk.get("earned"))
            rec_earn = _to_num(rk.get("earned"))

            raw_diff  = _diff(srv_raw,  rec_raw)
            att_diff  = _diff(srv_att,  rec_att)
            pct_diff  = _diff(srv_pct,  rec_pct)
            earn_diff = _diff(srv_earn, rec_earn)

            raw_flag  = _flag(raw_diff)
            att_flag  = _flag(att_diff)
            pct_flag  = _flag(pct_diff)
            earn_flag = _flag(earn_diff)

            for field, flag, diff_val in [
                ("raw",        raw_flag,  raw_diff),
                ("attainment", att_flag,  att_diff),
                ("percentile", pct_flag,  pct_diff),
                ("earned",     earn_flag, earn_diff),
            ]:
                if flag == "FAIL":
                    all_pass = False
                    print(
                        f"  [FAIL] {parent} | {kpi_id}.{field}: "
                        f"server={getattr(sk, 'get', dict.get)(sk, field)}  "
                        f"recomputed={getattr(rk, 'get', dict.get)(rk, field)}  "
                        f"diff={diff_val:.6f}"
                    )

            report_rows.append({
                "parent_supplier":       parent,
                "kpi_id":                kpi_id,
                "srv_raw":               srv_raw,
                "rec_raw":               rec_raw,
                "raw_diff":              raw_diff,
                "raw_flag":              raw_flag,
                "srv_attainment":        srv_att,
                "rec_attainment":        rec_att,
                "att_diff":              att_diff,
                "att_flag":              att_flag,
                "srv_percentile":        srv_pct,
                "rec_percentile":        rec_pct,
                "pct_diff":              pct_diff,
                "pct_flag":              pct_flag,
                "srv_earned":            srv_earn,
                "rec_earned":            rec_earn,
                "earn_diff":             earn_diff,
                "earn_flag":             earn_flag,
                "srv_normalized_score":  srv_norm,
                "rec_normalized_score":  rec_norm,
                "normalized_diff":       norm_diff,
                "normalized_flag":       norm_flag,
                "srv_coverage_pct":      srv_cov,
                "rec_coverage_pct":      rec_cov,
                "coverage_diff":         cov_diff,
                "coverage_flag":         cov_flag,
            })

    # ── Write CSV report ─────────────────────────────────────────────────────
    if report_rows:
        df = pd.DataFrame(report_rows)
        df.to_csv(REPORT_PATH, index=False)
        print(f"\nDetailed report written to: {REPORT_PATH}")
    else:
        print("\n[WARN] No data to report.")

    # ── Summary ──────────────────────────────────────────────────────────────
    total_checks = sum(
        1 for r in report_rows
        for flag_col in ["raw_flag", "att_flag", "pct_flag", "earn_flag"]
        if r[flag_col] in {"PASS", "FAIL"}
    )
    failed_checks = sum(
        1 for r in report_rows
        for flag_col in ["raw_flag", "att_flag", "pct_flag", "earn_flag"]
        if r[flag_col] == "FAIL"
    )
    norm_fails = sum(1 for r in report_rows if r["normalized_flag"] == "FAIL")

    print("\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)
    print(f"  Parent suppliers checked : {len(all_parents)}")
    print(f"  KPI field checks         : {total_checks}")
    print(f"  KPI field failures       : {failed_checks}")
    print(f"  Normalized score failures: {norm_fails}")
    print(f"  Overall result           : {'✓ ALL PASS' if all_pass else '✗ FAILURES DETECTED'}")
    print("=" * 70 + "\n")

    return all_pass


# ── CLI entry point ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Automated scorecard validation: recomputes and compares all KPI earned scores."
    )
    parser.add_argument("--zones",      nargs="*", help="Filter by zone(s)")
    parser.add_argument("--categories", nargs="*", help="Filter by category/categories")
    parser.add_argument("--parents",    nargs="*", help="Filter by parent supplier name(s)")
    parser.add_argument("--tolerance",  type=float, default=TOLERANCE,
                        help=f"Max allowed absolute diff for KPI fields (default {TOLERANCE})")
    args = parser.parse_args()

    TOLERANCE = args.tolerance  # type: ignore[assignment]
    TOLERANCE_SCORE = max(args.tolerance, 0.005)  # type: ignore[assignment]

    passed = run_validation(
        zones=args.zones,
        categories=args.categories,
        parents=args.parents,
    )
    sys.exit(0 if passed else 1)
