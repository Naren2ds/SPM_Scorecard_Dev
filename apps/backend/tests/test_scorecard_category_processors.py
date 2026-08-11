from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fetch_co2_emission import process as process_co2
from fetch_eclipse import process as process_eclipse
from fetch_dot_kpi import process as process_dot
from fetch_invoice_conformity import process as process_ic
from fetch_iot_kpi import process as process_iot
from fetch_supplier_assessment import process as process_sa
from fetch_supplier_compliance import process as process_sc
from fetch_supplier_maturity import process as process_sm
from fetch_price_divergence import process as process_pdiv


def _assert_column_present(frame: pd.DataFrame) -> None:
    assert "scorecard_category" in frame.columns
    assert frame["scorecard_category"].tolist() == ["Category A", "Category B"]


def test_dot_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category A",
            "on_time_delivered": 10,
            "total_delivered": 12,
            "x1_overdue": 1,
            "x2_future_due": 0,
            "dot_applicable": "Y",
            "delivery_month": "2026-05",
        },
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category B",
            "on_time_delivered": 5,
            "total_delivered": 8,
            "x1_overdue": 0,
            "x2_future_due": 0,
            "dot_applicable": "Y",
            "delivery_month": "2026-05",
        },
    ])

    processed = process_dot(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_iot_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category A",
            "invoice_on_time_count": 10,
            "total_po_lines": 12,
            "iot_applicable": "Y",
            "delivery_month": "2026-05",
        },
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category B",
            "invoice_on_time_count": 5,
            "total_po_lines": 8,
            "iot_applicable": "Y",
            "delivery_month": "2026-05",
        },
    ])

    processed = process_iot(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_supplier_assessment_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "supplier_category": "MALT",
            "scorecard_category": "Category A",
            "supplier_approval_status": "Approved",
            "annual_assessment": "Green",
        },
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "supplier_category": "MALT",
            "scorecard_category": "Category B",
            "supplier_approval_status": "Approved",
            "annual_assessment": "Green",
        },
    ])

    processed = process_sa(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_supplier_compliance_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "supplier_category": "MALT",
            "scorecard_category": "Category A",
            "supplier_approval_status": "Approved",
            "supplier_compliance_pct": 0.95,
        },
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "supplier_category": "MALT",
            "scorecard_category": "Category B",
            "supplier_approval_status": "Approved",
            "supplier_compliance_pct": 0.95,
        },
    ])

    processed = process_sc(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_supplier_maturity_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "supplier_category": "MALT",
            "scorecard_category": "Category A",
            "supplier_maturity_score_2025": 90,
        },
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "supplier_category": "MALT",
            "scorecard_category": "Category B",
            "supplier_maturity_score_2025": 90,
        },
    ])

    processed = process_sm(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_co2_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "supplier_category": "MALT",
            "scorecard_category": "Category A",
            "emissions_tco2e_2025": 10,
            "emissions_tco2e_2026": 20,
        },
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "supplier_category": "MALT",
            "scorecard_category": "Category B",
            "emissions_tco2e_2025": 10,
            "emissions_tco2e_2026": 20,
        },
    ])

    processed = process_co2(raw)

    assert len(processed) == 4
    _assert_column_present(processed[processed["year"] == "2025"])


def test_eclipse_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "supplier_category": "MALT",
            "scorecard_category": "Category A",
            "eclipse_score_2025": 90,
        },
        {
            "supplier_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "supplier_category": "MALT",
            "scorecard_category": "Category B",
            "eclipse_score_2025": 90,
        },
    ])

    processed = process_eclipse(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_invoice_conformity_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category A",
            "missing_po": 1,
            "wrong_po": 2,
            "wrong_invoice": 3,
            "total_invoices": 10,
        },
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category B",
            "missing_po": 1,
            "wrong_po": 2,
            "wrong_invoice": 3,
            "total_invoices": 10,
        },
    ])

    processed = process_ic(raw)

    assert len(processed) == 2
    _assert_column_present(processed)


def test_price_divergence_groups_by_scorecard_category():
    raw = pd.DataFrame([
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category A",
            "delivery_month": "2026-05",
            "total_po_value": 10,
            "total_invoice_value": 20,
        },
        {
            "vendor_name": "Supplier A",
            "parent_name": "Parent A",
            "zone": "EUR",
            "country": "Belgium",
            "gpo_category": "MALT",
            "scorecard_category": "Category B",
            "delivery_month": "2026-05",
            "total_po_value": 10,
            "total_invoice_value": 20,
        },
    ])

    processed = process_pdiv(raw)

    assert len(processed) == 2
    _assert_column_present(processed)
