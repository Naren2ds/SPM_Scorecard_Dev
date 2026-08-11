import csv
import io

import pytest

from iot_read_model import (
    IotConfig,
    build_iot_read_model,
    iter_iot_csv,
    query_iot_results,
    reconfigure_iot_read_model,
    search_iot_results,
    summarize_iot_model,
    validate_iot_config,
)


def _row(
    row_id,
    supplier,
    parent,
    on_time,
    total=100,
    *,
    applicable="Applicable",
    year="2026",
    zone="EUR",
    category="MALT",
    scorecard_category="Packaging",
):
    return {
        "id": row_id,
        "supplier": supplier,
        "parentSupplier": parent,
        "zone": zone,
        "country": "Belgium",
        "category": category,
        "scorecard_category": scorecard_category,
        "kpiApplicability": applicable,
        "invoiceOnTimeCount": str(on_time),
        "totalPoLines": str(total),
        "year": year,
        "month": "05",
    }


def _rows():
    return [
        _row("a1", "Alpha One", "Parent A", 80),
        _row("a2", "Alpha Two", "Parent A", 90),
        _row("b1", "Beta One", "Parent B", 70),
        _row("b2", "Beta Excluded", "Parent B", 100, applicable="Not Applicable"),
        _row("old", "Old Supplier", "Old Parent", 100, year="2024"),
    ]


def _config(mode="softStretch"):
    return IotConfig(max_score=10, critical_floor=0.7, target=0.85, formula_mode=mode)


def test_parent_rollup_uses_weighted_invoice_counts_and_full_cohort_rank():
    model = build_iot_read_model(_rows(), _config(), {"years": ["2026"]})
    parent_a = model.parent_index["Parent A"]
    parent_b = model.parent_index["Parent B"]

    assert parent_a.normalized_iot == pytest.approx(0.85)
    assert parent_a.raw_values.invoice_on_time == 170
    assert parent_a.raw_values.total_po_lines == 200
    assert parent_a.rank == 1
    assert parent_a.percentile == 1
    assert parent_a.earned == pytest.approx(10)
    assert parent_b.normalized_iot == pytest.approx(0.7)
    assert parent_b.rank == 2
    assert parent_b.earned == 0
    assert parent_b.contributing_rows == 1


def test_supplier_drilldown_keeps_global_supplier_rank():
    model = build_iot_read_model(_rows(), _config(), {"years": ["2026"]})
    result = query_iot_results(model, level="supplier", parents=["Parent A"])
    by_supplier = {item["supplier"]: item for item in result["items"]}

    assert result["total_items"] == 2
    assert by_supplier["Alpha Two"]["rankDescending"] == 1
    assert by_supplier["Alpha One"]["rankDescending"] == 2
    assert by_supplier["Alpha One"]["percentile"] == pytest.approx(0.5)


def test_percentiles_are_scoped_to_scorecard_category():
    rows = [
        _row("a", "A", "Parent A", 90, scorecard_category="Category A"),
        _row("b", "B", "Parent B", 80, scorecard_category="Category A"),
        _row("c", "C", "Parent C", 70, scorecard_category="Category B"),
        _row("d", "D", "Parent D", 60, scorecard_category="Category B"),
    ]
    model = build_iot_read_model(rows, _config())
    by_supplier = {result.label: result for result in model.supplier_results}

    assert by_supplier["A"].percentile == pytest.approx(1.0)
    assert by_supplier["B"].percentile == pytest.approx(0.0)
    assert by_supplier["C"].percentile == pytest.approx(1.0)
    assert by_supplier["D"].percentile == pytest.approx(0.0)
    assert model.parent_index["Parent C"].scorecard_category == "Category B"


def test_parent_selection_scopes_summary_zone_and_category_rollups():
    model = build_iot_read_model(_rows(), _config(), {"years": ["2026"]})
    summary = summarize_iot_model(model, "supplier", ["Parent A"])
    zone = query_iot_results(model, level="zone", parents=["Parent A"])
    category = query_iot_results(model, level="category", parents=["Parent A"])

    assert summary["result_count"] == 2
    assert summary["valid_result_count"] == 2
    assert zone["items"][0]["normalizedIot"] == pytest.approx(0.85)
    assert zone["items"][0]["contributingRows"] == 2
    assert category["items"][0]["normalizedIot"] == pytest.approx(0.85)


def test_supplier_summary_matches_selected_supplier_and_search_scope():
    model = build_iot_read_model(_rows(), _config(), {"years": ["2026"]})

    selected = summarize_iot_model(
        model,
        "supplier",
        ["Parent A"],
        ["Alpha One"],
    )
    searched = summarize_iot_model(
        model,
        "supplier",
        ["Parent A"],
        search="two",
    )

    assert selected["result_count"] == 1
    assert selected["average_iot_pct"] == 80
    assert searched["result_count"] == 1
    assert searched["average_iot_pct"] == 90


def test_strict_preview_changes_earned_without_mutating_saved_model():
    saved = build_iot_read_model(_rows(), _config(), {"years": ["2026"]})
    preview = reconfigure_iot_read_model(saved, _config("strict"))
    saved_alpha = next(row for row in saved.supplier_results if row.label == "Alpha One")
    preview_alpha = next(row for row in preview.supplier_results if row.label == "Alpha One")

    assert saved_alpha.earned == pytest.approx(5.6666666667)
    assert preview_alpha.earned == pytest.approx(3.3333333333)
    assert saved.config.formula_mode == "softStretch"
    assert preview.config.formula_mode == "strict"


def test_search_and_export_are_parent_scoped():
    model = build_iot_read_model(_rows(), _config(), {"years": ["2026"]})
    matches = search_iot_results(
        model,
        level="supplier",
        query="alpha",
        limit=30,
        parents=["Parent A"],
    )
    content = "".join(iter_iot_csv(model, parents=["Parent A"]))
    exported = list(csv.reader(io.StringIO(content)))

    assert {item["parentSupplier"] for item in matches} == {"Parent A"}
    assert exported[0] == ["IOT KPI Config"]
    assert exported[7][0:6] == ["Supplier", "Parent", "Zone", "Country", "Category", "Scorecard Category"]
    assert {row[0] for row in exported[8:]} == {"Alpha One", "Alpha Two"}
    assert {row[1] for row in exported[8:]} == {"Parent A"}


def test_missing_total_po_lines_and_invalid_config_are_handled():
    rows = [_row("missing", "Missing", "Parent Missing", 10, total=0)]
    model = build_iot_read_model(rows, _config())
    result = query_iot_results(model, level="supplier")

    assert result["items"][0]["normalizedIot"] is None
    assert result["items"][0]["scoreStatus"] == "Missing Data"
    assert validate_iot_config(IotConfig(10, 0.9, 0.8)) == [
        "Critical Floor must be less than Target."
    ]
