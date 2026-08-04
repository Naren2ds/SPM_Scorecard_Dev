"""Lightweight read models for the Normalized Scorecard API."""

from __future__ import annotations

import csv
import io
import math
from collections.abc import Iterable, Iterator
from typing import Any


LEADERBOARD_SORT_FIELDS = {
    "parentSupplier",
    "normalized_score",
    "coverage_pct",
    "coverage_adjusted_score",
    "invoice_value",
    "band",
}


def build_scorecard_read_model(result: dict[str, Any]) -> dict[str, Any]:
    """Create compact rows and an O(1) parent index over a scorecard result."""
    scorecards = result.get("scorecards", []) or []
    parent_index = {item["parentSupplier"]: item for item in scorecards}
    leaderboard = [
        {
            "parentSupplier": item["parentSupplier"],
            "normalized_score": item["normalized_score"],
            "coverage_pct": item["coverage_pct"],
            "coverage_adjusted_score": item["coverage_adjusted_score"],
            "invoice_value": item["invoice_value"],
            "band": item["band"],
            "pillar_scores": {
                pillar["pillar"]: pillar.get("pillar_pct")
                for pillar in item.get("pillars", [])
            },
        }
        for item in scorecards
    ]
    return {
        "result": result,
        "parent_index": parent_index,
        "leaderboard": leaderboard,
    }


def filter_leaderboard(
    rows: Iterable[dict[str, Any]],
    search: str | None = None,
) -> list[dict[str, Any]]:
    """Filter compact rows by a case-insensitive parent-name substring."""
    query = (search or "").strip().casefold()
    if not query:
        return list(rows)
    return [
        row
        for row in rows
        if query in str(row.get("parentSupplier", "")).casefold()
    ]


def sort_leaderboard(
    rows: Iterable[dict[str, Any]],
    sort: str,
    order: str,
) -> list[dict[str, Any]]:
    """Sort compact rows deterministically, using parent name for tie order."""
    if sort not in LEADERBOARD_SORT_FIELDS:
        raise ValueError(f"Unsupported leaderboard sort field: {sort}")
    if order not in {"asc", "desc"}:
        raise ValueError(f"Unsupported leaderboard sort order: {order}")

    items = sorted(
        rows,
        key=lambda row: str(row.get("parentSupplier", "")).casefold(),
    )
    if sort == "parentSupplier":
        if order == "desc":
            items.reverse()
        return items

    items.sort(key=lambda row: row.get(sort), reverse=order == "desc")
    return items


def paginate_leaderboard(
    rows: Iterable[dict[str, Any]],
    page: int,
    page_size: int,
) -> tuple[list[dict[str, Any]], int, int]:
    """Return one page plus total item and page counts."""
    items = list(rows)
    total_items = len(items)
    total_pages = math.ceil(total_items / page_size) if total_items else 0
    start = (page - 1) * page_size
    return items[start:start + page_size], total_items, total_pages


def summarize_scorecards(
    rows: Iterable[dict[str, Any]],
    *,
    total_parent_count: int,
    cached_at: str | None,
) -> dict[str, Any]:
    """Calculate the small summary payload used by the page header."""
    items = list(rows)
    count = len(items)
    if count:
        average_normalized = sum(row["normalized_score"] for row in items) / count
        average_coverage = sum(row["coverage_pct"] for row in items) / count
    else:
        average_normalized = 0.0
        average_coverage = 0.0

    band_counts = {"Green": 0, "Amber": 0, "Red": 0}
    for row in items:
        band = row.get("band")
        if band in band_counts:
            band_counts[band] += 1

    return {
        "total_parent_count": total_parent_count,
        "filtered_parent_count": count,
        "average_normalized_score": round(average_normalized, 2),
        "average_coverage_pct": round(average_coverage * 100.0, 2),
        "band_counts": band_counts,
        "cached_at": cached_at,
    }


def iter_scorecard_csv(
    result: dict[str, Any],
    scorecards: Iterable[dict[str, Any]],
) -> Iterator[str]:
    """Stream the detailed scorecard export without building one giant string."""
    kpis = result.get("kpis", []) or []
    header = [
        "Parent Supplier",
        "Normalized Score",
        "Coverage %",
        "Coverage-Adjusted",
        "Band",
    ]
    for kpi in kpis:
        header.extend([f"{kpi['name']} - Earned", f"{kpi['name']} - Max"])
    header.extend([
        "Service Level %",
        "Operational %",
        "Sustainability %",
        "Value Creation %",
    ])

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")

    def write_row(values: list[Any]) -> str:
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow(values)
        return buffer.getvalue()

    yield write_row(header)
    for scorecard in scorecards:
        kpi_by_id = {
            kpi["id"]: kpi
            for pillar in scorecard.get("pillars", [])
            for kpi in pillar.get("kpis", [])
        }
        pillar_by_name = {
            pillar["pillar"]: pillar
            for pillar in scorecard.get("pillars", [])
        }

        row: list[Any] = [
            scorecard["parentSupplier"],
            f"{scorecard['normalized_score']:.2f}",
            f"{scorecard['coverage_pct'] * 100.0:.2f}",
            f"{scorecard['coverage_adjusted_score']:.2f}",
            scorecard["band"],
        ]
        for kpi in kpis:
            detail = kpi_by_id.get(kpi["id"])
            earned = detail.get("earned") if detail else None
            row.extend([
                "" if earned is None else f"{earned:.3f}",
                f"{kpi['max_score']:.1f}",
            ])

        for pillar_name in (
            "Service Level",
            "Operational",
            "Sustainability",
            "Value Creation",
        ):
            pillar_pct = pillar_by_name.get(pillar_name, {}).get("pillar_pct")
            row.append("" if pillar_pct is None else f"{pillar_pct * 100.0:.2f}")
        yield write_row(row)
