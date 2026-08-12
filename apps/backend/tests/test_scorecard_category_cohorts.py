import pytest

from scorecard import KPI_CONFIGS, _aggregate_kpi, _kpi_attainments, compute_scorecard

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


def test_scorecard_aggregate_accepts_new_dimension_filters():
    kpi = next(item for item in ACTIVE_KPIS if item["id"] == "DOT")
    base = {
        "kpiApplicability": "Applicable",
        "onTimePoLines": "80",
        "totalDeliveredPoLines": "100",
        "x1DelayedOver30Days": "0",
        "x2EarlyOver30Days": "0",
    }
    rows = [
        {
            **base,
            "parentSupplier": "Parent A",
            "country": "India",
            "sub_category": "Glass",
            "purchasing_category": "Bottles",
            "scorecard_category": "Packaging",
        },
        {
            **base,
            "parentSupplier": "Parent B",
            "country": "Brazil",
            "sub_category": "Malt",
            "purchasing_category": "Raw Materials",
            "scorecard_category": "Ingredients",
        },
    ]

    aggregate = _aggregate_kpi(
        kpi,
        rows,
        None,
        None,
        None,
        countries={"India"},
        sub_categories={"Glass"},
        purchase_categories={"Bottles"},
        scorecard_categories={"Packaging"},
    )

    assert list(aggregate) == ["Parent A"]


def test_bst_scorecard_category_excludes_sustainability_pillar():
    cache = {
        "dot_kpi": [
            {
                "parentSupplier": "Parent BST",
                "scorecard_category": "BST",
                "kpiApplicability": "Applicable",
                "onTimePoLines": "100",
                "totalDeliveredPoLines": "100",
                "x1DelayedOver30Days": "0",
                "x2EarlyOver30Days": "0",
            }
        ],
        "supplier_maturity": [
            {
                "parentSupplier": "Parent BST",
                "scorecard_category": "BST",
                "kpiApplicability": "Applicable",
                "maturityScore": "100",
            }
        ],
        "eclipse": [
            {
                "parentSupplier": "Parent BST",
                "scorecard_category": "BST",
                "kpiApplicability": "Applicable",
                "eclipseScore": "100",
            }
        ],
        "co2_emission": [
            {
                "parentSupplier": "Parent BST",
                "scorecard_category": "BST",
                "kpiApplicability": "Applicable",
                "co2Emission": "100",
            }
        ],
    }

    result = compute_scorecard(cache, include_kpi_breakdown=True)
    scorecard = result["scorecards"][0]
    sustainability = next(
        pillar for pillar in scorecard["pillars"] if pillar["pillar"] == "Sustainability"
    )

    assert sustainability["status"] == "not_applicable"
    assert sustainability["applicable_max_points"] == 0
    assert sustainability["pillar_pct"] is None
    assert scorecard["applicable_pillar_weight"] == 40.0
    assert scorecard["expected_applicable_kpi_weight"] == 45.0
    assert scorecard["coverage_pct"] == round(10 / 45, 4)
    assert scorecard["coverage_adjusted_score"] < scorecard["normalized_score"]
    assert all(kpi["applicable"] is False for kpi in sustainability["kpis"])


def test_source_not_applicable_kpi_does_not_reduce_coverage():
    cache = {
        "dot_kpi": [
            {
                "parentSupplier": "Parent A",
                "scorecard_category": "Packaging",
                "kpiApplicability": "Applicable",
                "onTimePoLines": "100",
                "totalDeliveredPoLines": "100",
                "x1DelayedOver30Days": "0",
                "x2EarlyOver30Days": "0",
            }
        ],
        "iot_kpi": [
            {
                "parentSupplier": "Parent A",
                "scorecard_category": "Packaging",
                "kpiApplicability": "Not Applicable",
                "invoiceOnTimeCount": "0",
                "totalPoLines": "0",
            }
        ],
    }

    result = compute_scorecard(cache, include_kpi_breakdown=True)
    scorecard = result["scorecards"][0]
    iot = next(
        kpi
        for pillar in scorecard["pillars"]
        for kpi in pillar["kpis"]
        if kpi["id"] == "IOT"
    )

    assert iot["expected_applicable"] is False
    assert scorecard["expected_applicable_kpi_weight"] == 55.0
    assert scorecard["coverage_pct"] == round(10 / 55, 4)


def test_applicable_kpi_with_blank_value_reduces_coverage():
    cache = {
        "dot_kpi": [
            {
                "parentSupplier": "Parent A",
                "scorecard_category": "Packaging",
                "kpiApplicability": "Applicable",
                "onTimePoLines": "100",
                "totalDeliveredPoLines": "100",
                "x1DelayedOver30Days": "0",
                "x2EarlyOver30Days": "0",
            }
        ],
        "supplier_compliance": [
            {
                "parentSupplier": "Parent A",
                "scorecard_category": "Packaging",
                "kpiApplicability": "Applicable",
                "compliancePct": "",
            }
        ],
    }

    result = compute_scorecard(cache, include_kpi_breakdown=True)
    scorecard = result["scorecards"][0]
    compliance = next(
        kpi
        for pillar in scorecard["pillars"]
        for kpi in pillar["kpis"]
        if kpi["id"] == "SC"
    )

    assert compliance["applicable"] is False
    assert compliance["expected_applicable"] is True
    assert scorecard["expected_applicable_kpi_weight"] == 65.0
    assert scorecard["coverage_pct"] == round(10 / 65, 4)
