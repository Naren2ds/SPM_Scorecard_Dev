import csv
import io

import pytest

from pdiv_read_model import PdivConfig, build_pdiv_read_model, iter_pdiv_csv, query_pdiv_results


def _row(row_id, supplier, parent, zone, category, po_value, invoice_value):
    return {
        "id": row_id,
        "supplier": supplier,
        "parentSupplier": parent,
        "zone": zone,
        "country": "Belgium",
        "category": category,
        "kpiApplicability": "Applicable",
        "poValue": str(po_value),
        "invoiceValue": str(invoice_value),
        "year": "2026",
        "month": "05",
    }


def test_selected_parent_never_leaks_other_parent_rows_or_values():
    rows = [
        _row("a1", "Alpha One", "Parent A", "EUR", "MALT", 100, 110),
        _row("a2", "Alpha Two", "Parent A", "NAZ", "CANS", 200, 190),
        _row("b1", "Beta One", "Parent B", "EUR", "MALT", 100, 150),
    ]
    model = build_pdiv_read_model(rows, PdivConfig(5, 0.25, 0.199), {"years": ["2026"]})

    supplier = query_pdiv_results(model, level="supplier", parents=["Parent A"])
    zone = query_pdiv_results(model, level="zone", parents=["Parent A"])
    category = query_pdiv_results(model, level="category", parents=["Parent A"])
    exported = list(csv.reader(io.StringIO("".join(iter_pdiv_csv(model, parents=["Parent A"])))))

    assert {item["parentSupplier"] for item in supplier["items"]} == {"Parent A"}
    assert {item["supplier"] for item in supplier["items"]} == {"Alpha One", "Alpha Two"}
    assert sum(item["absoluteDifference"] for item in zone["items"]) == pytest.approx(20)
    assert sum(item["poValue"] for item in zone["items"]) == pytest.approx(300)
    assert sum(item["absoluteDifference"] for item in category["items"]) == pytest.approx(20)
    assert {row[1] for row in exported[8:]} == {"Parent A"}
