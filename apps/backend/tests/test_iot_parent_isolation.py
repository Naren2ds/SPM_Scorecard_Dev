import csv
import io

import pytest

from iot_read_model import IotConfig, build_iot_read_model, iter_iot_csv, query_iot_results


def _row(row_id, supplier, parent, on_time, *, zone, category, applicable="Applicable"):
    return {
        "id": row_id,
        "supplier": supplier,
        "parentSupplier": parent,
        "zone": zone,
        "country": "Belgium",
        "category": category,
        "kpiApplicability": applicable,
        "invoiceOnTimeCount": str(on_time),
        "totalPoLines": "100",
        "year": "2026",
        "month": "05",
    }


@pytest.fixture()
def model():
    rows = [
        _row("a1", "A Shared", "Parent A", 80, zone="Shared Zone", category="Shared Category"),
        _row("a2", "A Only", "Parent A", 90, zone="A Zone", category="A Category"),
        _row("a3", "A Excluded", "Parent A", 100, zone="Shared Zone", category="Shared Category", applicable="Not Applicable"),
        _row("b1", "B Shared", "Parent B", 10, zone="Shared Zone", category="Shared Category"),
        _row("b2", "B Only", "Parent B", 20, zone="B Zone", category="B Category"),
        _row("b3", "B Second Shared", "Parent B", 30, zone="Shared Zone", category="Shared Category"),
    ]
    return build_iot_read_model(rows, IotConfig(10, 0.7, 0.85), {"years": ["2026"]})


def test_supplier_view_never_returns_another_parent(model):
    response = query_iot_results(model, level="supplier", parents=["Parent A"])
    assert response["total_items"] == 3
    assert {item["parentSupplier"] for item in response["items"]} == {"Parent A"}


def test_shared_zone_and_category_do_not_mix_parents(model):
    zones = query_iot_results(model, level="zone", parents=["Parent A"])
    categories = query_iot_results(model, level="category", parents=["Parent A"])
    zone_by_name = {item["label"]: item for item in zones["items"]}
    category_by_name = {item["label"]: item for item in categories["items"]}

    assert set(zone_by_name) == {"Shared Zone", "A Zone"}
    assert zone_by_name["Shared Zone"]["normalizedIot"] == pytest.approx(0.8)
    assert set(category_by_name) == {"Shared Category", "A Category"}
    assert category_by_name["Shared Category"]["normalizedIot"] == pytest.approx(0.8)
    global_shared = next(
        item for item in query_iot_results(model, level="zone")["items"]
        if item["label"] == "Shared Zone"
    )
    assert global_shared["normalizedIot"] == pytest.approx(0.4)


def test_parent_export_contains_no_foreign_rows(model):
    content = "".join(iter_iot_csv(model, parents=["Parent A"]))
    rows = list(csv.DictReader(io.StringIO(content.split("Supplier Level\n", 1)[1])))
    assert len(rows) == 3
    assert {row["Parent"] for row in rows} == {"Parent A"}


def test_multiple_parent_selection_returns_exact_union(model):
    response = query_iot_results(model, level="supplier", parents=["Parent A", "Parent B"])
    assert response["total_items"] == 6
    assert {item["parentSupplier"] for item in response["items"]} == {"Parent A", "Parent B"}
