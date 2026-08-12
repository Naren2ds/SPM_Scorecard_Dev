"""
Normalized Supplier Scorecard computation.

Implements the framework from
  docs/Supplier_Performance_Normalized_Scorecard_Framework_Report.pdf (§5-§7)
and the KPI ↔ Pillar mapping from
  docs/Score_Card_Calculation_Proposed.xlsx  (sheet "Mapping").

Core formulas
-------------
    KPI attainment  = f(raw_value, floor, target, direction)   # 0..1
    Earned points   = attainment × KPI max_score
    Pillar Score %  = Σ(Earned KPI Points) / Σ(Applicable KPI Max Points)
    Normalized Score = Σ(Pillar Score × Pillar Weight) / Σ(Applicable Pillar Weight) × 100
    Coverage %      = Σ(Available KPI Weight) / Σ(Expected KPI Weight)
    Coverage-Adj    = Normalized Score × Coverage %

Pillar weights follow the Excel "Mapping" sheet:
    Service Level 40, Operational 20, Sustainability 20, Value Creation 20.
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

import pandas as pd


# ─── Configuration ──────────────────────────────────────────────────────────

PILLAR_WEIGHTS: dict[str, float] = {
    "Service Level": 40.0,
    "Operational": 20.0,
    "Sustainability": 20.0,
    "Value Creation": 20.0,
}


# Each KPI is aggregated to a single raw value per parent supplier, then scored
# with an attainment curve against (floor, target) thresholds.
#
#   direction = "higher"  → raw >= target ⇒ 1, raw <= floor ⇒ 0
#   direction = "lower"   → raw <= target ⇒ 1, raw >= floor ⇒ 0
#   direction = "quartile"→ floor = Q1, target = Q3 of the population,
#                            interpreted as higher-is-better.
#
# max_score values follow the Mapping sheet.  Where the mapping lists a
# "Quality" placeholder (max 15) under Service Level, we split it into the
# two real quality-related KPIs we actually collect:
#   Supplier Assessment (10) + Supplier Compliance (5) = 15.
KPI_CONFIGS: list[dict[str, Any]] = [
    # Service Level (pillar weight 40)
    {
        "id": "DOT",
        "name": "Delivery On Time",
        "pillar": "Service Level",
        "cache_key": "dot_kpi",
        "max_score": 10.0,
        "floor": 0.70,
        "target": 0.85,
        "direction": "higher",
        "unit": "percent",
    },
    {
        "id": "SA",
        "name": "Supplier Assessment",
        "pillar": "Service Level",
        "cache_key": "supplier_assessment",
        "max_score": 10.0,
        "floor": 0.50,
        "target": 0.80,
        "direction": "higher",
        "unit": "percent",
    },
    {
        "id": "SC",
        "name": "Supplier Compliance",
        "pillar": "Service Level",
        "cache_key": "supplier_compliance",
        "max_score": 5.0,
        "floor": 0.60,
        "target": 0.90,
        "direction": "higher",
        "unit": "percent",
    },
    # Operational (pillar weight 20)
    {
        "id": "PDIV",
        "name": "Price Divergence",
        "pillar": "Operational",
        "cache_key": "price_divergence",
        "max_score": 5.0,
        "floor": 0.25,
        "target": 0.199,
        "direction": "lower",
        "unit": "percent",
    },
    {
        "id": "IC",
        "name": "Invoice Conformity",
        "pillar": "Operational",
        "cache_key": "invoice_conformity",
        "max_score": 5.0,
        "floor": 0.70,
        "target": 0.85,
        "direction": "higher",
        "unit": "percent",
    },
    {
        "id": "IOT",
        "name": "Invoice On Time",
        "pillar": "Operational",
        "cache_key": "iot_kpi",
        "max_score": 10.0,
        "floor": 0.70,
        "target": 0.85,
        "direction": "higher",
        "unit": "percent",
    },
    # Sustainability (pillar weight 20)
    {
        "id": "SM",
        "name": "Supplier Maturity",
        "pillar": "Sustainability",
        "cache_key": "supplier_maturity",
        "max_score": 10.0,
        "floor": 0.60,
        "target": 0.80,
        "direction": "higher",
        "unit": "score_0_1",
    },
    {
        "id": "ECL",
        "name": "Eclipse Score",
        "pillar": "Sustainability",
        "cache_key": "eclipse",
        "max_score": 5.0,
        "floor": 0.50,
        "target": 0.80,
        "direction": "higher",
        "unit": "score_0_1",
    },
    {
        "id": "CO2",
        "name": "CO₂ Reduction Potential",
        "pillar": "Sustainability",
        "cache_key": "co2_emission",
        "max_score": 5.0,
        "floor": None,
        "target": None,
        "direction": "quartile",
        "unit": "tonnes",
    },
    # ─────────────────────────────────────────────────────────────────────
    # Mapping sheet also lists these KPIs but they have no data source in
    # this build. They are surfaced as placeholders (applicable=false by
    # default) so users can *see* the full framework and, if they want,
    # toggle a KPI to "Applicable" in the UI — which will then count in the
    # pillar denominator with 0 earned (framework §7 "Missing Applicable").
    # ─────────────────────────────────────────────────────────────────────
    {
        "id": "NPS",
        "name": "Net Promoter Score (NPS)",
        "pillar": "Service Level",
        "cache_key": None,
        "max_score": 5.0,
        "floor": None,
        "target": None,
        "direction": "higher",
        "unit": "score_0_1",
    },
    {
        "id": "TURN",
        "name": "Turnover",
        "pillar": "Service Level",
        "cache_key": None,
        "max_score": 5.0,
        "floor": None,
        "target": None,
        "direction": "higher",
        "unit": "score_0_1",
    },
    {
        "id": "POACC",
        "name": "PO Acceptance",
        "pillar": "Service Level",
        "cache_key": None,
        "max_score": 5.0,
        "floor": None,
        "target": None,
        "direction": "higher",
        "unit": "percent",
    },
    {
        "id": "COST",
        "name": "Cost",
        "pillar": "Value Creation",
        "cache_key": None,
        "max_score": 10.0,
        "floor": None,
        "target": None,
        "direction": "higher",
        "unit": "score_0_1",
    },
    {
        "id": "CASH",
        "name": "Cash",
        "pillar": "Value Creation",
        "cache_key": None,
        "max_score": 5.0,
        "floor": None,
        "target": None,
        "direction": "higher",
        "unit": "score_0_1",
    },
    {
        "id": "ENG",
        "name": "Engagement",
        "pillar": "Value Creation",
        "cache_key": None,
        "max_score": 5.0,
        "floor": None,
        "target": None,
        "direction": "higher",
        "unit": "score_0_1",
    },
]


# ─── Helpers ────────────────────────────────────────────────────────────────

def _to_num(value: Any) -> float | None:
    """Best-effort numeric coercion. Returns None on failure/blank."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if pd.notna(value) else None
    s = str(value).strip().replace(",", "").replace("%", "")
    if not s or s.lower() in {"nan", "none", "null"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _is_applicable(value: Any) -> bool:
    return str(value or "Applicable").strip().lower() != "not applicable"


def _attainment(raw: float, floor: float, target: float, direction: str) -> float:
    """Framework §6 attainment curve (0..1)."""
    if direction == "higher":
        if raw >= target:
            return 1.0
        if raw <= floor:
            return 0.0
        span = target - floor
        return (raw - floor) / span if span > 0 else 0.0
    # direction == "lower"
    if raw <= target:
        return 1.0
    if raw >= floor:
        return 0.0
    span = floor - target
    return (floor - raw) / span if span > 0 else 0.0


def _rollup_key(row: dict[str, Any]) -> str:
    """Parent supplier as scorecard grouping key.

    Rows with a blank/None parentSupplier are grouped under "Unassigned parent"
    so they form a single cohort entry — matching the frontend behaviour where
    ``dim(row.parentSupplier, "Unassigned parent")`` is used.
    """
    parent = str(row.get("parentSupplier", "") or "").strip()
    if parent and parent.lower() != "none":
        return parent
    return "Unassigned parent"


def _scorecard_category(row: dict[str, Any]) -> str:
    value = str(row.get("scorecard_category", "") or "").strip()
    return value or "Unassigned scorecard category"


def _is_excluded_by_scorecard_category(kpi: dict[str, Any], scorecard_category: str) -> bool:
    return kpi.get("pillar") == "Sustainability" and scorecard_category.strip().upper() == "BST"


def _collapse_scorecard_category(values: list[str]) -> str:
    cleaned = [value for value in values if value]
    if not cleaned:
        return "Unassigned scorecard category"
    counts = Counter(cleaned)
    most_common = counts.most_common()
    if len(most_common) == 1:
        return most_common[0][0]
    top_count = most_common[0][1]
    tied = sorted(value for value, count in most_common if count == top_count)
    return tied[0]


def _parent_scorecard_categories(
    cache: dict[str, Any],
    zones: set[str] | None,
    categories: set[str] | None,
    countries: set[str] | None,
    sub_categories: set[str] | None,
    purchase_categories: set[str] | None,
    scorecard_categories: set[str] | None,
    parents: set[str] | None,
) -> dict[str, str]:
    values: dict[str, list[str]] = {}
    for kpi in KPI_CONFIGS:
        cache_key = kpi.get("cache_key")
        if not cache_key:
            continue
        for row in cache.get(cache_key, []) or []:
            if not _passes_filters(
                row,
                zones,
                categories,
                countries,
                sub_categories,
                purchase_categories,
                scorecard_categories,
                parents,
            ):
                continue
            values.setdefault(_rollup_key(row), []).append(_scorecard_category(row))
    return {
        parent: _collapse_scorecard_category(scorecard_category_values)
        for parent, scorecard_category_values in values.items()
    }


def _index_kpi_applicability(
    kpi: dict[str, Any],
    rows: list[dict[str, Any]],
    zones: set[str] | None,
    categories: set[str] | None,
    countries: set[str] | None,
    sub_categories: set[str] | None,
    purchase_categories: set[str] | None,
    scorecard_categories: set[str] | None,
    parents: set[str] | None,
) -> tuple[set[str], set[str]]:
    """Index row presence and source applicability in one pass per KPI."""
    matched_parents: set[str] = set()
    applicable_parents: set[str] = set()
    for row in rows:
        if not _passes_filters(
            row,
            zones,
            categories,
            countries,
            sub_categories,
            purchase_categories,
            scorecard_categories,
            parents,
        ):
            continue
        parent = _rollup_key(row)
        matched_parents.add(parent)
        if (
            _is_applicable(row.get("kpiApplicability"))
            and not _is_excluded_by_scorecard_category(kpi, _scorecard_category(row))
        ):
            applicable_parents.add(parent)
    return matched_parents, applicable_parents


def _build_kpi_status_lookup(
    parent_universe: set[str],
    parent_scorecard_categories: dict[str, str],
    kpi_results: dict[str, dict[str, dict[str, Any]]],
    kpi_applicability_index: dict[str, tuple[set[str], set[str]]],
) -> dict[str, dict[str, str]]:
    """Derive each parent/KPI status once for score and coverage assembly."""
    lookup: dict[str, dict[str, str]] = {}
    for kpi in KPI_CONFIGS:
        kpi_id = kpi["id"]
        scored_parents = kpi_results[kpi_id]
        matched_parents, applicable_parents = kpi_applicability_index.get(
            kpi_id,
            (set(), set()),
        )
        statuses: dict[str, str] = {}
        for parent in parent_universe:
            parent_scorecard_category = parent_scorecard_categories.get(
                parent,
                "Unassigned scorecard category",
            )
            if not kpi.get("cache_key"):
                status = "BUSINESS_EXCLUDED"
            elif _is_excluded_by_scorecard_category(kpi, parent_scorecard_category):
                status = "BST_EXCLUDED"
            elif parent in scored_parents:
                status = "VALID_DATA"
            elif parent not in matched_parents or parent in applicable_parents:
                # No row, or an applicable row without enough usable values to score.
                status = "MISSING_DATA"
            else:
                status = "NOT_APPLICABLE"
            statuses[parent] = status
        lookup[kpi_id] = statuses
    return lookup


def _percentile_ranks(
    indexed_values: list[tuple[int, float | None]],
    target: float,
    *,
    higher_is_better: bool = True,
) -> dict[int, tuple[float, float, str]]:
    values = [(index, float(value)) for index, value in indexed_values if value is not None and pd.notna(value)]
    count = len(values)
    if not count:
        return {}
    if count == 1:
        return {values[0][0]: (1.0, 1.0, "single")}
    keys = {f"{value:.12f}" for _, value in values}
    if len(keys) == 1:
        percentile = 1.0 if values[0][1] >= target else 0.5
        average_rank = (count + 1) / 2
        return {index: (average_rank, percentile, "noVariance") for index, _ in values}

    sorted_values = sorted(values, key=lambda item: item[1], reverse=higher_is_better)
    result: dict[int, tuple[float, float, str]] = {}
    cursor = 0
    while cursor < count:
        key = f"{sorted_values[cursor][1]:.12f}"
        end = cursor + 1
        while end < count and f"{sorted_values[end][1]:.12f}" == key:
            end += 1
        average_rank = ((cursor + 1) + end) / 2
        percentile = (count - average_rank) / (count - 1)
        for index in range(cursor, end):
            result[sorted_values[index][0]] = (average_rank, percentile, "standard")
        cursor = end
    return result


def _passes_filters(
    row: dict[str, Any],
    zones: set[str] | None,
    categories: set[str] | None,
    countries: set[str] | None = None,
    sub_categories: set[str] | None = None,
    purchase_categories: set[str] | None = None,
    scorecard_categories: set[str] | None = None,
    parents: set[str] | None = None,
) -> bool:
    if zones and str(row.get("zone", "")).strip() not in zones:
        return False
    if categories and str(row.get("category", "")).strip() not in categories:
        return False
    if countries and str(row.get("country", "")).strip() not in countries:
        return False
    if sub_categories and str(row.get("sub_category", "")).strip() not in sub_categories:
        return False
    if purchase_categories and str(row.get("purchasing_category", "")).strip() not in purchase_categories:
        return False
    if scorecard_categories and _scorecard_category(row) not in scorecard_categories:
        return False
    if parents and _rollup_key(row) not in parents:
        return False
    return True


def _parent_invoice_totals(
    cache: dict[str, Any],
    zones: set[str] | None,
    categories: set[str] | None,
    countries: set[str] | None = None,
    sub_categories: set[str] | None = None,
    purchase_categories: set[str] | None = None,
    scorecard_categories: set[str] | None = None,
    parents: set[str] | None = None,
) -> dict[str, float]:
    """
    Total invoice value per parent supplier, aggregated from price_divergence
    (which carries per-invoice ``invoiceValue``). Falls back to ``poValue`` when
    an invoice value is missing so the row still contributes to the ranking.
    """
    totals: dict[str, float] = {}
    for r in cache.get("price_divergence", []) or []:
        if not _passes_filters(
            r,
            zones,
            categories,
            countries,
            sub_categories,
            purchase_categories,
            scorecard_categories,
            parents,
        ):
            continue
        if not _is_applicable(r.get("kpiApplicability")):
            continue
        inv = _to_num(r.get("invoiceValue"))
        if inv is None:
            inv = _to_num(r.get("poValue"))
        if inv is None:
            continue
        key = _rollup_key(r)
        totals[key] = totals.get(key, 0.0) + inv
    return totals


# ─── Per-KPI aggregation to a single ratio per parent supplier ─────────────

def _aggregate_kpi(
    kpi: dict[str, Any],
    rows: list[dict[str, Any]],
    zones: set[str] | None,
    categories: set[str] | None,
    parents: set[str] | None,
    *,
    countries: set[str] | None = None,
    sub_categories: set[str] | None = None,
    purchase_categories: set[str] | None = None,
    scorecard_categories: set[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """
    Return { parent_key: { raw, ratio, applicable } } for a single KPI.

    'ratio' is the value fed into the attainment curve (percent / 0-1 score /
    tonnes value depending on unit).  'applicable' is True only when the parent
    has at least one applicable row with usable data for this KPI.
    """
    agg: dict[str, dict[str, Any]] = {}

    kid = kpi["id"]

    for r in rows:
        if not _passes_filters(
            r,
            zones,
            categories,
            countries,
            sub_categories,
            purchase_categories,
            scorecard_categories,
            parents,
        ):
            continue
        if _is_excluded_by_scorecard_category(kpi, _scorecard_category(r)):
            continue
        if not _is_applicable(r.get("kpiApplicability")):
            continue
        key = _rollup_key(r)
        bucket = agg.setdefault(
            key,
            {"num": 0.0, "den": 0.0, "sum": 0.0, "n": 0.0, "scorecard_categories": []},
        )

        if kid == "DOT":
            on_time = _to_num(r.get("onTimePoLines")) or 0.0
            total = _to_num(r.get("totalDeliveredPoLines")) or 0.0
            delayed = _to_num(r.get("x1DelayedOver30Days")) or 0.0
            early = _to_num(r.get("x2EarlyOver30Days")) or 0.0
            adj_den = total + 0.99 * delayed + 0.10 * early
            bucket["num"] += on_time
            bucket["den"] += adj_den
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "IOT":
            on_time = _to_num(r.get("invoiceOnTimeCount")) or 0.0
            total = _to_num(r.get("totalPoLines")) or 0.0
            bucket["num"] += on_time
            bucket["den"] += total
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "IC":
            total_inv = _to_num(r.get("totalInvoices")) or 0.0
            mismatches = _to_num(r.get("mismatchCount")) or 0.0
            conformant = max(total_inv - mismatches, 0.0)
            bucket["num"] += conformant
            bucket["den"] += total_inv
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "PDIV":
            po_val = _to_num(r.get("poValue"))
            inv_val = _to_num(r.get("invoiceValue"))
            if po_val is None or inv_val is None or po_val <= 0:
                continue
            bucket["num"] += abs(inv_val - po_val)
            bucket["den"] += po_val
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "SA":
            g = _to_num(r.get("greenCount")) or 0.0
            y = _to_num(r.get("yellowCount")) or 0.0
            red = _to_num(r.get("redCount")) or 0.0
            # Match the frontend SA page formula:
            #   health = (green×1.0 + yellow×0.5 + red×0) / (green+yellow+red)
            # Blank rows are excluded from the denominator (same as totalValidAssessments).
            valid = g + y + red
            if valid <= 0:
                continue
            bucket["num"] += g * 1.0 + y * 0.5
            bucket["den"] += valid
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "SC":
            v = _to_num(r.get("compliancePct"))
            if v is None:
                continue
            bucket["sum"] += v
            bucket["n"] += 1.0
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "SM":
            v = _to_num(r.get("maturityScore"))
            if v is None:
                continue
            # Normalize to 0..1 if given as 0..100.
            if v > 1.0:
                v = v / 100.0
            bucket["sum"] += v
            bucket["n"] += 1.0
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "ECL":
            v = _to_num(r.get("eclipseScore"))
            if v is None:
                continue
            if v > 1.0:
                v = v / 100.0
            bucket["sum"] += v
            bucket["n"] += 1.0
            bucket["scorecard_categories"].append(_scorecard_category(r))

        elif kid == "CO2":
            v = _to_num(r.get("co2Emission"))
            if v is None:
                continue
            bucket["sum"] += v
            bucket["n"] += 1.0
            bucket["scorecard_categories"].append(_scorecard_category(r))

    out: dict[str, dict[str, Any]] = {}
    for key, b in agg.items():
        if kid in {"SC", "SM", "ECL", "CO2"}:
            if b["n"] <= 0:
                continue
            ratio = b["sum"] / b["n"]
        else:
            if b["den"] <= 0:
                continue
            ratio = b["num"] / b["den"]
        out[key] = {
            "raw": ratio,
            "ratio": ratio,
            "applicable": True,
            "scorecard_category": _collapse_scorecard_category(b.get("scorecard_categories", [])),
        }
    return out


# ─── Attainment application (with quartile-based CO2 handling) ─────────────

def _kpi_attainments(
    kpi: dict[str, Any],
    per_parent: dict[str, dict[str, Any]],
    individual_values: list[float] | None = None,
) -> dict[str, dict[str, Any]]:
    """Convert raw per-parent ratios into attainment/percentile/earned for one KPI.

    Formula mirrors the frontend KPI pages exactly (softStretch mode):
        earned = max_score × attainment × (0.70 + 0.30 × percentile)

    Percentile uses the same midpoint-rank / (N-1) formula as the frontend:
        percentile = (N - averageRank) / (N - 1)
    where averageRank is the midpoint of tied positions (1-indexed).
    Special cases:
      - N=1            → percentile = 1.0
      - all values same → percentile = 1.0 if value >= target else 0.5

    ``individual_values`` (optional): for quartile KPIs, compute Q1/Q3 from these
    individual-row values instead of from the per-parent averages.  This matches
    the frontend which derives Q1/Q3 from the individual supplier rows.
    """
    direction = kpi["direction"]
    floor, target = kpi["floor"], kpi["target"]

    if direction == "quartile":
        # Use individual row values when provided (matches frontend computeQuartileDefaults).
        # Fall back to parent averages if not supplied.
        values = individual_values if individual_values is not None else [v["ratio"] for v in per_parent.values()]
        if len(values) >= 2:
            s = pd.Series(values, dtype=float)
            q1, q3 = float(s.quantile(0.25)), float(s.quantile(0.75))
            if q3 <= q1:
                q3 = q1 + 1e-9
            floor, target = q1, q3
            direction = "higher"
        else:
            # Cannot form quartiles — award full attainment.
            floor, target = 0.0, 1.0
            direction = "higher"

    # Step 1: compute raw attainments.
    attainments: dict[str, float] = {
        key: _attainment(info["ratio"], float(floor), float(target), direction)
        for key, info in per_parent.items()
    }

    # Step 2: compute percentile ranks.
    # Every KPI compares parents only within the same scorecard_category.
    percentiles: dict[str, float] = {}
    grouped: dict[str, list[tuple[str, float]]] = {}
    for key, info in per_parent.items():
        cohort = _scorecard_category(info)
        grouped.setdefault(cohort, []).append((key, info["ratio"]))

    for cohort_values in grouped.values():
        local_values = [(index, value) for index, (_, value) in enumerate(cohort_values)]
        cohort_ranks = _percentile_ranks(
            local_values,
            float(target),
            higher_is_better=direction != "lower",
        )
        for index, (key, _) in enumerate(cohort_values):
            percentiles[key] = cohort_ranks[index][1]

    # Step 3: apply soft-stretch formula (matches frontend default).
    result: dict[str, dict[str, Any]] = {}
    for key in per_parent:
        att = attainments[key]
        pct = percentiles[key]
        earned = kpi["max_score"] * att * (0.70 + 0.30 * pct)
        result[key] = {
            "raw": per_parent[key]["raw"],
            "scorecard_category": _scorecard_category(per_parent[key]),
            "attainment": att,
            "percentile": pct,
            "earned": earned,
            "max": kpi["max_score"],
            "floor_used": float(floor),
            "target_used": float(target),
        }
    return result


# ─── Public entry point ────────────────────────────────────────────────────

def compute_scorecard(
    cache: dict[str, Any],
    zones: Iterable[str] | None = None,
    categories: Iterable[str] | None = None,
    parents: Iterable[str] | None = None,
    *,
    countries: Iterable[str] | None = None,
    sub_categories: Iterable[str] | None = None,
    purchase_categories: Iterable[str] | None = None,
    scorecard_categories: Iterable[str] | None = None,
    include_kpi_breakdown: bool = True,
    top_n: int | None = None,
) -> dict[str, Any]:
    """
    Build the normalized scorecard for every parent supplier that has at least
    one applicable KPI reading matching the filters.

    Set ``include_kpi_breakdown=False`` to return a lightweight response for
    the leaderboard view (drops per-KPI details, keeps pillar totals only).

    ``top_n`` (optional): rank parents by aggregated invoice value from
    price_divergence (highest first) and return only the top ``N``. Parents
    without any invoice value in the filter window are dropped from the
    Top-N view (they can still be inspected via an explicit ``parents=`` query).
    """
    zones_set = {z for z in (zones or []) if z}
    categories_set = {c for c in (categories or []) if c}
    countries_set = {c for c in (countries or []) if c}
    sub_categories_set = {s for s in (sub_categories or []) if s}
    purchase_categories_set = {p for p in (purchase_categories or []) if p}
    scorecard_categories_set = {s for s in (scorecard_categories or []) if s}
    parents_set = {p for p in (parents or []) if p}
    filter_args = (
        zones_set or None,
        categories_set or None,
        countries_set or None,
        sub_categories_set or None,
        purchase_categories_set or None,
        scorecard_categories_set or None,
    )

    invoice_totals = _parent_invoice_totals(
        cache,
        *filter_args,
        parents_set or None,
    )

    # When Top-N is requested, identify which parents appear in the top N by
    # invoice value so we can filter the *response* at the end.  Crucially,
    # percentile ranking must still be computed across the FULL population;
    # restricting ranking to only the top N would give those parents
    # artificially inflated percentiles and earned scores.
    top_parent_set: set[str] | None = None
    if top_n and top_n > 0:
        ranked = sorted(invoice_totals.items(), key=lambda kv: kv[1], reverse=True)
        top_parent_set = {p for p, _ in ranked[:top_n]}
        # If explicit parents filter was passed too, intersect them.
        if parents_set:
            top_parent_set &= parents_set

    # Step 1 — per-KPI, per-parent aggregation across the full population.
    # top_parent_set is only used to filter the final response, NOT here.
    kpi_results: dict[str, dict[str, dict[str, Any]]] = {}
    kpi_applicability_index: dict[str, tuple[set[str], set[str]]] = {}
    kpi_meta: list[dict[str, Any]] = []
    for kpi in KPI_CONFIGS:
        rows = cache.get(kpi["cache_key"], []) or []
        kpi_applicability_index[kpi["id"]] = _index_kpi_applicability(
            kpi,
            rows,
            *filter_args,
            parents_set or None,
        )
        agg = _aggregate_kpi(
            kpi,
            rows,
            filter_args[0],
            filter_args[1],
            parents_set or None,
            countries=filter_args[2],
            sub_categories=filter_args[3],
            purchase_categories=filter_args[4],
            scorecard_categories=filter_args[5],
        )
        # For quartile KPIs (CO2), collect individual row values so Q1/Q3 are
        # computed from the supplier-level distribution — matching the frontend
        # computeQuartileDefaults(filteredRows) behaviour.
        individual_vals: list[float] | None = None
        if kpi["direction"] == "quartile":
            individual_vals = []
            value_field = "co2Emission"  # only quartile KPI in current config
            for r in (rows or []):
                if not _passes_filters(
                    r,
                    *filter_args,
                    parents_set or None,
                ):
                    continue
                if _is_excluded_by_scorecard_category(kpi, _scorecard_category(r)):
                    continue
                if not _is_applicable(r.get("kpiApplicability")):
                    continue
                v = _to_num(r.get(value_field))
                if v is not None:
                    individual_vals.append(v)
        scored = _kpi_attainments(kpi, agg, individual_values=individual_vals)
        kpi_results[kpi["id"]] = scored
        kpi_meta.append({
            "id": kpi["id"],
            "name": kpi["name"],
            "pillar": kpi["pillar"],
            "max_score": kpi["max_score"],
            "floor": kpi["floor"],
            "target": kpi["target"],
            "direction": kpi["direction"],
            "unit": kpi["unit"],
        })

    # Step 2 — build the universe of parent suppliers from all scored parents.
    # Percentile ranks are computed inside _kpi_attainments across this full set.
    parent_universe: set[str] = set()
    for scored in kpi_results.values():
        parent_universe.update(scored.keys())
    parent_scorecard_categories = _parent_scorecard_categories(
        cache,
        *filter_args,
        parents_set or None,
    )
    kpi_status_lookup = _build_kpi_status_lookup(
        parent_universe,
        parent_scorecard_categories,
        kpi_results,
        kpi_applicability_index,
    )

    # Total expected KPI weight across all pillars (for coverage %).
    total_expected_weight = sum(k["max_score"] for k in KPI_CONFIGS)
    kpis_by_pillar: dict[str, list[dict[str, Any]]] = {}
    for k in KPI_CONFIGS:
        kpis_by_pillar.setdefault(k["pillar"], []).append(k)

    # Step 3 — assemble per-parent scorecards
    scorecards: list[dict[str, Any]] = []
    for parent in sorted(parent_universe):
        pillars_out: list[dict[str, Any]] = []
        weighted_sum = 0.0
        applicable_pillar_weight = 0.0
        available_kpi_weight = 0.0
        expected_applicable_kpi_weight = 0.0
        total_earned = 0.0
        total_applicable_max = 0.0
        parent_scorecard_category = parent_scorecard_categories.get(
            parent,
            "Unassigned scorecard category",
        )

        for pillar_name, pillar_weight in PILLAR_WEIGHTS.items():
            pillar_kpis = kpis_by_pillar.get(pillar_name, [])
            kpi_breakdown: list[dict[str, Any]] = []
            earned_sum = 0.0
            max_sum = 0.0

            for kpi in pillar_kpis:
                scored = kpi_results[kpi["id"]].get(parent)
                applicability_status = kpi_status_lookup[kpi["id"]][parent]
                expected_applicable = applicability_status in {"VALID_DATA", "MISSING_DATA"}
                if expected_applicable:
                    expected_applicable_kpi_weight += kpi["max_score"]
                if scored is None:
                    if include_kpi_breakdown:
                        kpi_breakdown.append({
                            "id": kpi["id"],
                            "name": kpi["name"],
                            "max_score": kpi["max_score"],
                            "raw": None,
                            "scorecard_category": parent_scorecard_category if expected_applicable else None,
                            "attainment": None,
                            "earned": None,
                            "applicable": False,
                            "expected_applicable": expected_applicable,
                            "floor_used": kpi["floor"],
                            "target_used": kpi["target"],
                        })
                    continue
                if include_kpi_breakdown:
                    kpi_breakdown.append({
                        "id": kpi["id"],
                        "name": kpi["name"],
                        "max_score": kpi["max_score"],
                        "raw": scored["raw"],
                        "scorecard_category": scored["scorecard_category"],
                        "attainment": scored["attainment"],
                        "percentile": scored.get("percentile"),
                        "earned": scored["earned"],
                        "applicable": True,
                        "expected_applicable": True,
                        "floor_used": scored["floor_used"],
                        "target_used": scored["target_used"],
                    })
                earned_sum += scored["earned"]
                max_sum += kpi["max_score"]
                available_kpi_weight += kpi["max_score"]

            if max_sum > 0:
                pillar_pct = earned_sum / max_sum
                weighted = pillar_pct * pillar_weight
                weighted_sum += weighted
                applicable_pillar_weight += pillar_weight
                total_earned += earned_sum
                total_applicable_max += max_sum
                pillar_status = "applicable"
            else:
                pillar_pct = None
                weighted = 0.0
                pillar_status = "not_applicable"

            pillars_out.append({
                "pillar": pillar_name,
                "weight": pillar_weight,
                "earned_points": earned_sum,
                "applicable_max_points": max_sum,
                "pillar_pct": pillar_pct,
                "weighted_contribution": weighted,
                "status": pillar_status,
                "kpis": kpi_breakdown if include_kpi_breakdown else [],
            })

        normalized = (
            (weighted_sum / applicable_pillar_weight) * 100.0
            if applicable_pillar_weight > 0
            else 0.0
        )
        coverage = (
            available_kpi_weight / expected_applicable_kpi_weight
            if expected_applicable_kpi_weight > 0
            else 0.0
        )
        coverage_adjusted = normalized * coverage

        scorecards.append({
            "parentSupplier": parent,
            "normalized_score": round(normalized, 2),
            "coverage_pct": round(coverage, 4),
            "coverage_adjusted_score": round(coverage_adjusted, 2),
            "applicable_pillar_weight": applicable_pillar_weight,
            "expected_applicable_kpi_weight": round(expected_applicable_kpi_weight, 2),
            "total_earned": round(total_earned, 2),
            "total_applicable_max": round(total_applicable_max, 2),
            "invoice_value": round(invoice_totals.get(parent, 0.0), 2),
            "band": _score_band(normalized),
            "pillars": pillars_out,
        })

    scorecards.sort(key=lambda s: s["normalized_score"], reverse=True)
    if top_parent_set is not None:
        # Filter response to top-N and sort by invoice value for display.
        scorecards = [s for s in scorecards if s["parentSupplier"] in top_parent_set]
        scorecards.sort(key=lambda s: s["invoice_value"], reverse=True)

    return {
        "pillar_weights": PILLAR_WEIGHTS,
        "total_expected_kpi_weight": total_expected_weight,
        "kpis": kpi_meta,
        "scorecards": scorecards,
        "filters_applied": {
            "zones": sorted(zones_set),
            "categories": sorted(categories_set),
            "parents": sorted(parents_set),
            "top_n": top_n,
        },
    }


def _score_band(score: float) -> str:
    """Simple red/amber/green banding for the header card."""
    if score >= 80:
        return "Green"
    if score >= 60:
        return "Amber"
    return "Red"


# ─── Filter option discovery (for slicer dropdowns) ────────────────────────

def list_filter_options(cache: dict[str, Any]) -> dict[str, list[str]]:
    """Collect distinct scorecard slicer values across all KPIs."""
    zones: set[str] = set()
    categories: set[str] = set()
    countries: set[str] = set()
    sub_categories: set[str] = set()
    purchase_categories: set[str] = set()
    scorecard_categories: set[str] = set()
    parents: set[str] = set()

    for kpi in KPI_CONFIGS:
        for r in cache.get(kpi["cache_key"], []) or []:
            z = str(r.get("zone", "") or "").strip()
            if z:
                zones.add(z)
            c = str(r.get("category", "") or "").strip()
            if c:
                categories.add(c)
            country = str(r.get("country", "") or "").strip()
            if country:
                countries.add(country)
            sub_category = str(r.get("sub_category", "") or "").strip()
            if sub_category:
                sub_categories.add(sub_category)
            purchase_category = str(r.get("purchasing_category", "") or "").strip()
            if purchase_category:
                purchase_categories.add(purchase_category)
            ranking_category = _scorecard_category(r)
            if ranking_category:
                scorecard_categories.add(ranking_category)
            p = _rollup_key(r)
            if p and p != "(Unknown)":
                parents.add(p)

    return {
        "zones": sorted(zones),
        "categories": sorted(categories),
        "countries": sorted(countries),
        "subCategories": sorted(sub_categories),
        "purchaseCategories": sorted(purchase_categories),
        "scorecardCategories": sorted(scorecard_categories),
        "parents": sorted(parents),
    }
