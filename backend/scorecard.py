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
        "floor": 0.05,
        "target": 0.02,
        "direction": "lower",
        "unit": "percent",
    },
    {
        "id": "IC",
        "name": "Invoice Conformity",
        "pillar": "Operational",
        "cache_key": "invoice_conformity",
        "max_score": 5.0,
        "floor": 0.80,
        "target": 0.95,
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
        "floor": 0.40,
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
    """Parent supplier as scorecard grouping key (with sensible fallback)."""
    parent = str(row.get("parentSupplier", "") or "").strip()
    if parent and parent.lower() != "none":
        return parent
    return str(row.get("supplier", "") or "").strip() or "(Unknown)"


def _passes_filters(
    row: dict[str, Any],
    zones: set[str] | None,
    categories: set[str] | None,
    parents: set[str] | None,
) -> bool:
    if zones and str(row.get("zone", "")).strip() not in zones:
        return False
    if categories and str(row.get("category", "")).strip() not in categories:
        return False
    if parents and _rollup_key(row) not in parents:
        return False
    return True


def _parent_invoice_totals(
    cache: dict[str, Any],
    zones: set[str] | None,
    categories: set[str] | None,
    parents: set[str] | None,
) -> dict[str, float]:
    """
    Total invoice value per parent supplier, aggregated from price_divergence
    (which carries per-invoice ``invoiceValue``). Falls back to ``poValue`` when
    an invoice value is missing so the row still contributes to the ranking.
    """
    totals: dict[str, float] = {}
    for r in cache.get("price_divergence", []) or []:
        if not _passes_filters(r, zones, categories, parents):
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
) -> dict[str, dict[str, Any]]:
    """
    Return { parent_key: { raw, ratio, applicable } } for a single KPI.

    'ratio' is the value fed into the attainment curve (percent / 0-1 score /
    tonnes value depending on unit).  'applicable' is True only when the parent
    has at least one applicable row with usable data for this KPI.
    """
    agg: dict[str, dict[str, float]] = {}

    kid = kpi["id"]

    for r in rows:
        if not _passes_filters(r, zones, categories, parents):
            continue
        if not _is_applicable(r.get("kpiApplicability")):
            continue
        key = _rollup_key(r)
        bucket = agg.setdefault(key, {"num": 0.0, "den": 0.0, "sum": 0.0, "n": 0.0})

        if kid == "DOT":
            on_time = _to_num(r.get("onTimePoLines")) or 0.0
            total = _to_num(r.get("totalDeliveredPoLines")) or 0.0
            delayed = _to_num(r.get("x1DelayedOver30Days")) or 0.0
            early = _to_num(r.get("x2EarlyOver30Days")) or 0.0
            adj_den = total + 0.99 * delayed + 0.10 * early
            bucket["num"] += on_time
            bucket["den"] += adj_den

        elif kid == "IOT":
            on_time = _to_num(r.get("invoiceOnTimeCount")) or 0.0
            total = _to_num(r.get("totalPoLines")) or 0.0
            bucket["num"] += on_time
            bucket["den"] += total

        elif kid == "IC":
            total_inv = _to_num(r.get("totalInvoices")) or 0.0
            mismatches = _to_num(r.get("mismatchCount")) or 0.0
            conformant = max(total_inv - mismatches, 0.0)
            bucket["num"] += conformant
            bucket["den"] += total_inv

        elif kid == "PDIV":
            po_val = _to_num(r.get("poValue"))
            inv_val = _to_num(r.get("invoiceValue"))
            if po_val is None or inv_val is None or po_val <= 0:
                continue
            bucket["num"] += abs(inv_val - po_val)
            bucket["den"] += po_val

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

        elif kid == "SC":
            v = _to_num(r.get("compliancePct"))
            if v is None:
                continue
            bucket["sum"] += v
            bucket["n"] += 1.0

        elif kid == "SM":
            v = _to_num(r.get("maturityScore"))
            if v is None:
                continue
            # Normalize to 0..1 if given as 0..100.
            if v > 1.0:
                v = v / 100.0
            bucket["sum"] += v
            bucket["n"] += 1.0

        elif kid == "ECL":
            v = _to_num(r.get("eclipseScore"))
            if v is None:
                continue
            if v > 1.0:
                v = v / 100.0
            bucket["sum"] += v
            bucket["n"] += 1.0

        elif kid == "CO2":
            v = _to_num(r.get("co2Emission"))
            if v is None:
                continue
            bucket["sum"] += v
            bucket["n"] += 1.0

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
        out[key] = {"raw": ratio, "ratio": ratio, "applicable": True}
    return out


# ─── Attainment application (with quartile-based CO2 handling) ─────────────

def _kpi_attainments(
    kpi: dict[str, Any],
    per_parent: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Convert raw per-parent ratios into attainment/percentile/earned for one KPI.

    Formula matches the frontend individual KPI page default (softStretch mode):
        earned = max_score × attainment × (0.70 + 0.30 × percentile)

    Percentile is computed across the full population passed in ``per_parent``.
    Best-performing parent = 100th percentile; worst = 1/N percentile.
    With a single observation the parent receives the 100th percentile.
    """
    direction = kpi["direction"]
    floor, target = kpi["floor"], kpi["target"]

    if direction == "quartile":
        values = [v["ratio"] for v in per_parent.values()]
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

    # Step 2: compute percentile ranks across the population.
    # For "higher" direction: higher raw ratio → better → higher percentile.
    # For "lower"  direction: lower  raw ratio → better → higher percentile.
    reverse_sort = (direction != "lower")
    sorted_keys = sorted(
        per_parent.keys(),
        key=lambda k: per_parent[k]["ratio"],
        reverse=reverse_sort,
    )
    total = len(sorted_keys)
    # Rank 0 (best) → percentile = total/total = 1.0
    # Rank N-1 (worst) → percentile = 1/total
    percentiles: dict[str, float] = {
        key: (total - rank_0idx) / total
        for rank_0idx, key in enumerate(sorted_keys)
    }

    # Step 3: apply soft-stretch formula (matches frontend default).
    result: dict[str, dict[str, Any]] = {}
    for key in per_parent:
        att = attainments[key]
        pct = percentiles[key]
        earned = kpi["max_score"] * att * (0.70 + 0.30 * pct)
        result[key] = {
            "raw": per_parent[key]["raw"],
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
    parents_set = {p for p in (parents or []) if p}

    invoice_totals = _parent_invoice_totals(
        cache,
        zones_set or None,
        categories_set or None,
        parents_set or None,
    )

    # When Top-N is requested, restrict the whole computation universe to just
    # those parents so we don't score all 8 000+ suppliers just to throw them
    # away. This turns a ~6 MB payload into ~50 KB.
    top_parent_set: set[str] | None = None
    if top_n and top_n > 0:
        ranked = sorted(invoice_totals.items(), key=lambda kv: kv[1], reverse=True)
        top_parent_set = {p for p, _ in ranked[:top_n]}
        # If explicit parents filter was passed too, intersect them.
        if parents_set:
            top_parent_set &= parents_set

    # Step 1 — per-KPI, per-parent aggregation
    kpi_results: dict[str, dict[str, dict[str, Any]]] = {}
    kpi_meta: list[dict[str, Any]] = []
    aggregation_parents = top_parent_set if top_parent_set is not None else parents_set
    for kpi in KPI_CONFIGS:
        rows = cache.get(kpi["cache_key"], []) or []
        agg = _aggregate_kpi(
            kpi,
            rows,
            zones_set or None,
            categories_set or None,
            aggregation_parents or None,
        )
        scored = _kpi_attainments(kpi, agg)
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

    # Step 2 — build the universe of parent suppliers
    if top_parent_set is not None:
        parent_universe: set[str] = set(top_parent_set)
    else:
        parent_universe = set()
        for scored in kpi_results.values():
            parent_universe.update(scored.keys())

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
        total_earned = 0.0
        total_applicable_max = 0.0

        for pillar_name, pillar_weight in PILLAR_WEIGHTS.items():
            pillar_kpis = kpis_by_pillar.get(pillar_name, [])
            kpi_breakdown: list[dict[str, Any]] = []
            earned_sum = 0.0
            max_sum = 0.0

            for kpi in pillar_kpis:
                scored = kpi_results[kpi["id"]].get(parent)
                if scored is None:
                    if include_kpi_breakdown:
                        kpi_breakdown.append({
                            "id": kpi["id"],
                            "name": kpi["name"],
                            "max_score": kpi["max_score"],
                            "raw": None,
                            "attainment": None,
                            "earned": None,
                            "applicable": False,
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
                        "attainment": scored["attainment"],
                        "percentile": scored.get("percentile"),
                        "earned": scored["earned"],
                        "applicable": True,
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
            available_kpi_weight / total_expected_weight
            if total_expected_weight > 0
            else 0.0
        )
        coverage_adjusted = normalized * coverage

        scorecards.append({
            "parentSupplier": parent,
            "normalized_score": round(normalized, 2),
            "coverage_pct": round(coverage, 4),
            "coverage_adjusted_score": round(coverage_adjusted, 2),
            "applicable_pillar_weight": applicable_pillar_weight,
            "total_earned": round(total_earned, 2),
            "total_applicable_max": round(total_applicable_max, 2),
            "invoice_value": round(invoice_totals.get(parent, 0.0), 2),
            "band": _score_band(normalized),
            "pillars": pillars_out,
        })

    if top_parent_set is not None:
        # Preserve invoice-value ranking as the primary order for Top-N views.
        scorecards.sort(key=lambda s: s["invoice_value"], reverse=True)
    else:
        scorecards.sort(key=lambda s: s["normalized_score"], reverse=True)

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
    """Collect distinct zones / categories / parent suppliers across all KPIs."""
    zones: set[str] = set()
    categories: set[str] = set()
    parents: set[str] = set()

    for kpi in KPI_CONFIGS:
        for r in cache.get(kpi["cache_key"], []) or []:
            z = str(r.get("zone", "") or "").strip()
            if z:
                zones.add(z)
            c = str(r.get("category", "") or "").strip()
            if c:
                categories.add(c)
            p = _rollup_key(r)
            if p and p != "(Unknown)":
                parents.add(p)

    return {
        "zones": sorted(zones),
        "categories": sorted(categories),
        "parents": sorted(parents),
    }
