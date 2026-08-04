import csv
import io

import pytest

from dot_read_model import (
    DotConfig,
    build_dot_read_model,
    iter_dot_csv,
    query_dot_results,
    search_dot_results,
    summarize_dot_model,
    validate_dot_config,
)


def _row(
    row_id,
    supplier,
    parent,
    on_time,
    total,
    *,
    applicable="Applicable",
    year="2026",
    zone="EUR",
    category="MALT",
):
    return {
        "id": row_id,
        "supplier": supplier,
        "parentSupplier": parent,
        "zone": zone,
        "country": "Belgium",
        "category": category,
        "kpiApplicability": applicable,
        "dotPercent": "",
        "onTimePoLines": str(on_time),
        "totalDeliveredPoLines": str(total),
        "x1DelayedOver30Days": "0",
        "x2EarlyOver30Days": "0",
        "year": year,
        "month": "05",
    }


def _rows():
    return [
        _row("a1", "Alpha One", "Parent A", 80, 100),
        _row("a2", "Alpha Two", "Parent A", 90, 100),
        _row("b1", "Beta One", "Parent B", 70, 100),
        _row("b2", "Beta Excluded", "Parent B", 100, 100, applicable="Not Applicable"),
        _row("old", "Old Supplier", "Old Parent", 100, 100, year="2024"),
    ]


def _config(mode="softStretch"):
    return DotConfig(max_score=10, critical_floor=0.7, target=0.85, formula_mode=mode)


def test_parent_rollup_uses_weighted_raw_values_and_full_cohort_rank():
    model = build_dot_read_model(_rows(), _config(), {"years": ["2026"]})

    parent_a = model.parent_index["Parent A"]
    parent_b = model.parent_index["Parent B"]
    assert parent_a.normalized_dot == pytest.approx(0.85)
    assert parent_a.raw_values.on_time == 170
    assert parent_a.raw_values.total_delivered == 200
    assert parent_a.rank == 1
    assert parent_a.percentile == 1
    assert parent_a.earned == pytest.approx(10)
    assert parent_b.normalized_dot == pytest.approx(0.7)
    assert parent_b.rank == 2
    assert parent_b.percentile == 0
    assert parent_b.earned == 0
    assert parent_b.contributing_rows == 1


def test_parent_display_filter_does_not_recalculate_percentile():
    model = build_dot_read_model(_rows(), _config(), {"years": ["2026"]})
    result = query_dot_results(
        model,
        level="parent",
        parents=["Parent B"],
        page=1,
        page_size=100,
    )

    assert result["total_items"] == 1
    assert result["items"][0]["label"] == "Parent B"
    assert result["items"][0]["rankDescending"] == 2
    assert result["items"][0]["percentile"] == 0


def test_supplier_results_keep_full_cohort_rank_when_drilling_into_parent():
    model = build_dot_read_model(_rows(), _config(), {"years": ["2026"]})
    result = query_dot_results(
        model,
        level="supplier",
        parents=["Parent A"],
        page=1,
        page_size=100,
    )

    by_supplier = {item["supplier"]: item for item in result["items"]}
    assert result["total_items"] == 2
    assert by_supplier["Alpha Two"]["rankDescending"] == 1
    assert by_supplier["Alpha One"]["rankDescending"] == 2
    assert by_supplier["Alpha One"]["percentile"] == pytest.approx(0.5)


def test_parent_selection_scopes_supplier_summary_zone_and_category_rollups():
    model = build_dot_read_model(_rows(), _config(), {"years": ["2026"]})
    supplier_summary = summarize_dot_model(model, "supplier", ["Parent A"])
    zone = query_dot_results(model, level="zone", parents=["Parent A"])
    category = query_dot_results(model, level="category", parents=["Parent A"])

    assert supplier_summary["result_count"] == 2
    assert supplier_summary["valid_result_count"] == 2
    assert zone["total_items"] == 1
    assert zone["items"][0]["normalizedDot"] == pytest.approx(0.85)
    assert zone["items"][0]["contributingRows"] == 2
    assert category["total_items"] == 1
    assert category["items"][0]["normalizedDot"] == pytest.approx(0.85)


def test_strict_preview_changes_earned_score_without_changing_saved_model():
    saved = build_dot_read_model(_rows(), _config("softStretch"), {"years": ["2026"]})
    preview = build_dot_read_model(_rows(), _config("strict"), {"years": ["2026"]})

    saved_alpha = next(row for row in saved.supplier_results if row.label == "Alpha One")
    preview_alpha = next(row for row in preview.supplier_results if row.label == "Alpha One")
    assert saved_alpha.earned == pytest.approx(5.6666666667)
    assert preview_alpha.earned == pytest.approx(3.3333333333)
    assert saved.config.formula_mode == "softStretch"
    assert preview.config.formula_mode == "strict"


def test_summary_search_and_export_contracts():
    model = build_dot_read_model(_rows(), _config(), {"years": ["2026"]})
    summary = summarize_dot_model(model)
    matches = search_dot_results(model, level="parent", query="parent a", limit=30)
    content = "".join(iter_dot_csv(model, parents=["Parent A"]))
    exported = list(csv.reader(io.StringIO(content)))

    assert summary["source_row_count"] == 5
    assert summary["cohort_row_count"] == 4
    assert summary["result_count"] == 2
    assert matches[0]["label"] == "Parent A"
    assert exported[0] == ["DOT Config"]
    assert exported[7][0:5] == ["Supplier", "Parent", "Zone", "Country", "Category"]
    assert {row[0] for row in exported[8:]} == {"Alpha One", "Alpha Two"}


def test_invalid_config_is_rejected():
    errors = validate_dot_config(DotConfig(10, 0.9, 0.8, "softStretch"))
    assert "Critical Floor must be less than Target." in errors
