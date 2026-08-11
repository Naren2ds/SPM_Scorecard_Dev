import pytest

from scorecard import KPI_CONFIGS, _aggregate_kpi, _kpi_attainments

ACTIVE_KPIS = [kpi for kpi in KPI_CONFIGS if kpi.get("cache_key")]


@pytest.mark.parametrize("kpi", ACTIVE_KPIS, ids=lambda kpi: kpi["id"])
def test_every_kpi_percentile_is_scoped_to_scorecard_category(kpi):
    higher_is_better = kpi["direction"] != "lower"
    values = (0.90, 0.80, 0.70, 0.60) if higher_is_better else (0.10, 0.20, 0.30, 0.40)
    parents = {
        "Category A best": {"raw": values[0], "ratio": values[0], "scorecard_category": "Category A"},
        "Category A worst": {"raw": values[1], "ratio": values[1], "scorecard_category": "Category A"},
        "Category B best": {"raw": values[2], "ratio": values[2], "scorecard_category": "Category B"},
        "Category B worst": {"raw": values[3], "ratio": values[3], "scorecard_category": "Category B"},
    }

    result = _kpi_attainments(kpi, parents, individual_values=[0.1, 0.2, 0.3, 0.4])

    assert result["Category A best"]["percentile"] == pytest.approx(1.0)
    assert result["Category A worst"]["percentile"] == pytest.approx(0.0)
    assert result["Category B best"]["percentile"] == pytest.approx(1.0)
    assert result["Category B worst"]["percentile"] == pytest.approx(0.0)


VALID_FIELDS = {
    "DOT": {"onTimePoLines": "90", "totalDeliveredPoLines": "100"},
    "IOT": {"invoiceOnTimeCount": "90", "totalPoLines": "100"},
    "IC": {"totalInvoices": "100", "mismatchCount": "10"},
    "PDIV": {"poValue": "100", "invoiceValue": "110"},
    "SA": {"greenCount": "9", "yellowCount": "1", "redCount": "0"},
    "SC": {"compliancePct": "0.9"},
    "SM": {"maturityScore": "0.9"},
    "ECL": {"eclipseScore": "0.9"},
    "CO2": {"co2Emission": "0.9"},
}


@pytest.mark.parametrize("kpi", ACTIVE_KPIS, ids=lambda kpi: kpi["id"])
def test_every_kpi_aggregate_preserves_scorecard_category(kpi):
    row = {
        "parentSupplier": "Parent A",
        "scorecard_category": "Packaging",
        "kpiApplicability": "Applicable",
        **VALID_FIELDS[kpi["id"]],
    }

    aggregate = _aggregate_kpi(kpi, [row], None, None, None)

    assert aggregate["Parent A"]["scorecard_category"] == "Packaging"
