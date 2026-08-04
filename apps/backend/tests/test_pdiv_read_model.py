import csv
import io

import pytest

from pdiv_read_model import (
    PdivConfig,
    build_pdiv_read_model,
    iter_pdiv_csv,
    query_pdiv_results,
    reconfigure_pdiv_read_model,
    search_pdiv_results,
    summarize_pdiv_model,
    validate_pdiv_config,
)


def _row(
    row_id,
    supplier,
    parent,
    po_value,
    invoice_value,
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
        "poValue": str(po_value),
        "invoiceValue": str(invoice_value),
        "year": year,
        "month": "05",
    }


def _rows():
    return [
        _row("a1", "Alpha One", "Parent A", 100, 110),
        _row("a2", "Alpha Two", "Parent A", 200, 190),
        _row("b1", "Beta One", "Parent B", 100, 125),
        _row("b2", "Beta Excluded", "Parent B", 100, 100, applicable="Not Applicable"),
        _row("old", "Old Supplier", "Old Parent", 100, 100, year="2024"),
    ]


def _config(mode="softStretch"):
    return PdivConfig(max_score=5, critical_floor=0.25, target=0.199, formula_mode=mode)


def test_parent_rollup_preserves_production_sum_of_absolute_differences_formula():
    model = build_pdiv_read_model(_rows(), _config(), {"years": ["2026"]})
    parent_a = model.parent_index["Parent A"]
    parent_b = model.parent_index["Parent B"]

    assert parent_a.raw_values.absolute_difference == 20
    assert parent_a.raw_values.po_value == 300
    assert parent_a.normalized_divergence == pytest.approx(20 / 300)
    assert parent_a.normalized_divergence != 0
    assert parent_a.rank == 1
    assert parent_a.percentile == 1
    assert parent_a.earned == pytest.approx(5)
    assert parent_b.normalized_divergence == pytest.approx(0.25)
    assert parent_b.rank == 2
    assert parent_b.earned == 0
    assert parent_b.contributing_rows == 1


def test_supplier_drilldown_keeps_global_lower_is_better_rank():
    model = build_pdiv_read_model(_rows(), _config(), {"years": ["2026"]})
    result = query_pdiv_results(model, level="supplier", parents=["Parent A"])
    by_supplier = {item["supplier"]: item for item in result["items"]}

    assert result["total_items"] == 2
    assert by_supplier["Alpha Two"]["rankAscending"] == 1
    assert by_supplier["Alpha One"]["rankAscending"] == 2
    assert by_supplier["Alpha One"]["percentile"] == pytest.approx(0.5)


def test_parent_selection_scopes_summary_zone_and_category_rollups():
    model = build_pdiv_read_model(_rows(), _config(), {"years": ["2026"]})
    summary = summarize_pdiv_model(model, "supplier", ["Parent A"])
    zone = query_pdiv_results(model, level="zone", parents=["Parent A"])
    category = query_pdiv_results(model, level="category", parents=["Parent A"])

    assert summary["result_count"] == 2
    assert summary["valid_result_count"] == 2
    assert zone["items"][0]["normalizedDivergence"] == pytest.approx(20 / 300)
    assert zone["items"][0]["contributingRows"] == 2
    assert category["items"][0]["normalizedDivergence"] == pytest.approx(20 / 300)


def test_supplier_summary_matches_selected_supplier_and_search_scope():
    model = build_pdiv_read_model(_rows(), _config(), {"years": ["2026"]})
    selected = summarize_pdiv_model(model, "supplier", ["Parent A"], ["Alpha One"])
    searched = summarize_pdiv_model(model, "supplier", ["Parent A"], search="two")

    assert selected["result_count"] == 1
    assert selected["average_divergence_pct"] == 10
    assert searched["result_count"] == 1
    assert searched["average_divergence_pct"] == 5


def test_strict_preview_changes_earned_without_mutating_saved_model():
    saved = build_pdiv_read_model(_rows(), _config(), {"years": ["2026"]})
    preview = reconfigure_pdiv_read_model(saved, _config("strict"))
    saved_alpha = next(row for row in saved.supplier_results if row.label == "Alpha One")
    preview_alpha = next(row for row in preview.supplier_results if row.label == "Alpha One")

    assert saved_alpha.earned == pytest.approx(4.25)
    assert preview_alpha.earned == pytest.approx(2.5)
    assert saved.config.formula_mode == "softStretch"
    assert preview.config.formula_mode == "strict"


def test_search_and_export_are_parent_scoped():
    model = build_pdiv_read_model(_rows(), _config(), {"years": ["2026"]})
    matches = search_pdiv_results(
        model,
        level="supplier",
        query="alpha",
        limit=30,
        parents=["Parent A"],
    )
    content = "".join(iter_pdiv_csv(model, parents=["Parent A"]))
    exported = list(csv.reader(io.StringIO(content)))

    assert {item["parentSupplier"] for item in matches} == {"Parent A"}
    assert exported[0] == ["Price Divergence KPI Config"]
    assert exported[7][0:5] == ["Supplier", "Parent", "Zone", "Country", "Category"]
    assert {row[0] for row in exported[8:]} == {"Alpha One", "Alpha Two"}
    assert {row[1] for row in exported[8:]} == {"Parent A"}


def test_nonpositive_po_and_invalid_config_are_handled():
    rows = [_row("missing", "Missing", "Parent Missing", 0, 10)]
    model = build_pdiv_read_model(rows, _config())
    result = query_pdiv_results(model, level="supplier")

    assert result["items"][0]["normalizedDivergence"] is None
    assert result["items"][0]["scoreStatus"] == "Missing Data"
    assert model.parent_results == []
    assert validate_pdiv_config(PdivConfig(5, 0.1, 0.2)) == [
        "Critical Floor must be greater than Target for Price Divergence."
    ]
