import csv
from pathlib import Path

import pytest

from pdiv_read_model import PdivConfig, build_pdiv_read_model, query_pdiv_results
from scorecard import KPI_CONFIGS, _aggregate_kpi, _kpi_attainments


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "price_divergence.csv"


@pytest.fixture(scope="module")
def current_pdiv_data():
    with DATA_PATH.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    cohort = [row for row in rows if row.get("year") in {"2025", "2026"}]
    kpi = next(item for item in KPI_CONFIGS if item["id"] == "PDIV")
    config = PdivConfig(
        max_score=float(kpi["max_score"]),
        critical_floor=float(kpi["floor"]),
        target=float(kpi["target"]),
    )
    return rows, cohort, kpi, build_pdiv_read_model(rows, config, {"years": ["2025", "2026"]})


def test_every_parent_matches_existing_scorecard_formula_and_scoring(current_pdiv_data):
    _, cohort, kpi, model = current_pdiv_data
    official_raw = _aggregate_kpi(kpi, cohort, None, None, None)
    official_scored = _kpi_attainments(kpi, official_raw)

    assert set(model.parent_index) == set(official_scored)
    for parent, expected in official_scored.items():
        actual = model.parent_index[parent]
        assert actual.normalized_divergence == pytest.approx(expected["raw"])
        assert actual.attainment == pytest.approx(expected["attainment"])
        assert actual.percentile == pytest.approx(expected["percentile"])
        assert actual.earned == pytest.approx(expected["earned"])


def test_current_data_has_expected_large_parent_first_shape(current_pdiv_data):
    rows, cohort, _, model = current_pdiv_data
    assert model.source_row_count == len(rows)
    assert model.cohort_row_count == len(cohort)
    assert len(model.parent_results) > 20_000
    assert model._supplier_results is None
    assert model._zone_results is None
    assert model._category_results is None


def test_sampled_parent_rollups_are_fully_isolated(current_pdiv_data):
    _, _, _, model = current_pdiv_data
    sampled = [row.label for row in model.parent_results if row.contributing_rows > 1][:10]
    assert sampled
    for parent in sampled:
        assessments = [
            row for row in model.assessments
            if str(row.row.get("parentSupplier") or "").strip() == parent and row.is_valid
        ]
        expected_po = sum(row.raw_values.po_value for row in assessments)
        expected_difference = sum(row.raw_values.absolute_difference for row in assessments)
        zone = query_pdiv_results(model, level="zone", parents=[parent], page_size=200)
        category = query_pdiv_results(model, level="category", parents=[parent], page_size=200)

        assert sum(item["poValue"] for item in zone["items"]) == pytest.approx(expected_po)
        assert sum(item["absoluteDifference"] for item in zone["items"]) == pytest.approx(expected_difference)
        assert sum(item["poValue"] for item in category["items"]) == pytest.approx(expected_po)
        assert sum(item["absoluteDifference"] for item in category["items"]) == pytest.approx(expected_difference)
