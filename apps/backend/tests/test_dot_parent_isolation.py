import csv
import io

import pytest

from dot_read_model import (
    DotConfig,
    build_dot_read_model,
    iter_dot_csv,
    query_dot_results,
    reconfigure_dot_read_model,
    search_dot_results,
    summarize_dot_model,
)


def _row(
    row_id,
    supplier,
    parent,
    on_time,
    *,
    zone,
    category,
    applicable="Applicable",
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
        "totalDeliveredPoLines": "100",
        "x1DelayedOver30Days": "0",
        "x2EarlyOver30Days": "0",
        "year": "2026",
        "month": "05",
    }


@pytest.fixture()
def isolated_model():
    rows = [
        _row("a1", "A Shared Supplier", "Parent A", 80, zone="Shared Zone", category="Shared Category"),
        _row("a2", "A Only Supplier", "Parent A", 90, zone="A Zone", category="A Category"),
        _row("a3", "A Excluded Supplier", "Parent A", 100, zone="Shared Zone", category="Shared Category", applicable="Not Applicable"),
        _row("b1", "B Shared Supplier", "Parent B", 10, zone="Shared Zone", category="Shared Category"),
        _row("b2", "B Only Supplier", "Parent B", 20, zone="B Zone", category="B Category"),
        _row("b3", "B Second Shared Supplier", "Parent B", 30, zone="Shared Zone", category="Shared Category"),
    ]
    return build_dot_read_model(
        rows,
        DotConfig(max_score=10, critical_floor=0.7, target=0.85),
        {"years": ["2026"]},
    )


def test_parent_and_supplier_views_never_return_another_parent(isolated_model):
    parent = query_dot_results(isolated_model, level="parent", parents=["Parent A"])
    suppliers = query_dot_results(isolated_model, level="supplier", parents=["Parent A"])

    assert [item["label"] for item in parent["items"]] == ["Parent A"]
    assert parent["items"][0]["rankDescending"] == isolated_model.parent_index["Parent A"].rank
    assert suppliers["total_items"] == 3
    assert {item["parentSupplier"] for item in suppliers["items"]} == {"Parent A"}
    assert {item["supplier"] for item in suppliers["items"]} == {
        "A Shared Supplier",
        "A Only Supplier",
        "A Excluded Supplier",
    }


def test_shared_zone_and_category_rollups_use_only_selected_parent(isolated_model):
    zones = query_dot_results(isolated_model, level="zone", parents=["Parent A"])
    categories = query_dot_results(isolated_model, level="category", parents=["Parent A"])
    zone_by_name = {item["label"]: item for item in zones["items"]}
    category_by_name = {item["label"]: item for item in categories["items"]}

    assert set(zone_by_name) == {"Shared Zone", "A Zone"}
    assert zone_by_name["Shared Zone"]["normalizedDot"] == pytest.approx(0.8)
    assert zone_by_name["Shared Zone"]["contributingRows"] == 1
    assert zone_by_name["A Zone"]["normalizedDot"] == pytest.approx(0.9)
    assert set(category_by_name) == {"Shared Category", "A Category"}
    assert category_by_name["Shared Category"]["normalizedDot"] == pytest.approx(0.8)
    assert category_by_name["Shared Category"]["contributingRows"] == 1

    # If Parent B leaked into the shared groups, both values would be below 0.8.
    global_zones = query_dot_results(isolated_model, level="zone")
    global_shared = next(item for item in global_zones["items"] if item["label"] == "Shared Zone")
    assert global_shared["normalizedDot"] == pytest.approx(0.4)


def test_summary_and_search_are_parent_scoped(isolated_model):
    summary = summarize_dot_model(isolated_model, "supplier", ["Parent A"])
    supplier_matches = search_dot_results(
        isolated_model,
        level="supplier",
        query="supplier",
        limit=30,
        parents=["Parent A"],
    )
    zone_matches = search_dot_results(
        isolated_model,
        level="zone",
        query="shared",
        limit=30,
        parents=["Parent A"],
    )

    assert summary["result_count"] == 3
    assert summary["valid_result_count"] == 2
    assert {item["parentSupplier"] for item in supplier_matches} == {"Parent A"}
    assert {item["label"] for item in supplier_matches} == {
        "A Shared Supplier",
        "A Only Supplier",
        "A Excluded Supplier",
    }
    assert [item["label"] for item in zone_matches] == ["Shared Zone"]


def test_export_contains_only_selected_parent_rows(isolated_model):
    content = "".join(iter_dot_csv(isolated_model, parents=["Parent A"]))
    rows = list(csv.DictReader(io.StringIO(content.split("Supplier Level\n", 1)[1])))

    assert len(rows) == 3
    assert {row["Parent"] for row in rows} == {"Parent A"}
    assert {row["Supplier"] for row in rows} == {
        "A Shared Supplier",
        "A Only Supplier",
        "A Excluded Supplier",
    }


def test_preview_preserves_parent_scope_and_does_not_mutate_saved_model(isolated_model):
    preview = reconfigure_dot_read_model(
        isolated_model,
        DotConfig(max_score=10, critical_floor=0.7, target=0.85, formula_mode="strict"),
    )
    preview_rows = query_dot_results(preview, level="supplier", parents=["Parent A"])

    assert {item["parentSupplier"] for item in preview_rows["items"]} == {"Parent A"}
    assert preview.config.formula_mode == "strict"
    assert isolated_model.config.formula_mode == "softStretch"


def test_multiple_parent_selection_returns_only_the_selected_union(isolated_model):
    only_a = query_dot_results(isolated_model, level="supplier", parents=["Parent A"])
    both = query_dot_results(
        isolated_model,
        level="supplier",
        parents=["Parent A", "Parent B"],
    )

    assert {item["parentSupplier"] for item in only_a["items"]} == {"Parent A"}
    assert both["total_items"] == 6
    assert {item["parentSupplier"] for item in both["items"]} == {"Parent A", "Parent B"}
