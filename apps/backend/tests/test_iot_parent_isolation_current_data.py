from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd
import pytest

from iot_read_model import IotConfig, build_iot_read_model, query_iot_results
from scorecard import KPI_CONFIGS, _aggregate_kpi


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "iot_kpi.csv"


@pytest.fixture(scope="module")
def current_iot_model():
    if not DATA_PATH.exists():
        pytest.skip("Current IOT CSV is not available.")
    rows = pd.read_csv(DATA_PATH, dtype=str).fillna("").to_dict(orient="records")
    model = build_iot_read_model(
        rows,
        IotConfig(max_score=10, critical_floor=0.7, target=0.85),
        {"years": ["2025", "2026"]},
    )
    rows_by_parent = defaultdict(list)
    for assessment in model.assessments:
        parent = str(assessment.row.get("parentSupplier") or "").strip() or "Unassigned parent"
        rows_by_parent[parent].append(assessment)
    return model, rows_by_parent


def _signature(response):
    return {
        item["label"]: (item["normalizedIot"], item["contributingRows"])
        for item in response["items"]
    }


def test_every_iot_parent_count_matches_its_own_applicable_rows(current_iot_model):
    model, rows_by_parent = current_iot_model
    expected = Counter({
        parent: sum(1 for assessment in rows if assessment.is_applicable)
        for parent, rows in rows_by_parent.items()
    })
    expected_parents = {parent for parent, count in expected.items() if count > 0}

    assert set(model.parent_index) == expected_parents
    for parent, result in model.parent_index.items():
        assert result.contributing_rows == expected[parent]


def test_every_iot_parent_ratio_matches_existing_scorecard_aggregation(current_iot_model):
    model, _ = current_iot_model
    kpi = next(item for item in KPI_CONFIGS if item["id"] == "IOT")
    cohort_rows = [assessment.row for assessment in model.assessments]
    expected = _aggregate_kpi(kpi, cohort_rows, zones=None, categories=None, parents=None)

    assert set(model.parent_index) == set(expected)
    for parent, result in model.parent_index.items():
        assert result.normalized_iot == pytest.approx(expected[parent]["ratio"])


def test_sampled_iot_parents_return_no_foreign_supplier_rows(current_iot_model):
    model, rows_by_parent = current_iot_model
    parents = sorted(model.parent_index)
    step = max(len(parents) // 50, 1)
    for parent in parents[::step][:50]:
        response = query_iot_results(
            model,
            level="supplier",
            parents=[parent],
            page_size=max(len(rows_by_parent[parent]), 1),
        )
        assert response["total_items"] == len(rows_by_parent[parent])
        assert {item["parentSupplier"] for item in response["items"]} == {parent}


def test_sampled_iot_rollups_match_full_parent_isolation(current_iot_model):
    model, rows_by_parent = current_iot_model
    candidates = sorted(
        parent for parent in model.parent_index
        if 1 <= len(rows_by_parent[parent]) <= 100
    )
    step = max(len(candidates) // 20, 1)
    for parent in candidates[::step][:20]:
        parent_rows = [assessment.row for assessment in rows_by_parent[parent]]
        isolated = build_iot_read_model(parent_rows, model.config)
        page_size = max(len(parent_rows), 1)
        for level in ("zone", "category"):
            scoped = query_iot_results(
                model,
                level=level,
                parents=[parent],
                page_size=page_size,
            )
            standalone = query_iot_results(isolated, level=level, page_size=page_size)
            scoped_signature = _signature(scoped)
            standalone_signature = _signature(standalone)
            assert scoped_signature.keys() == standalone_signature.keys()
            for label, (iot, contributors) in scoped_signature.items():
                standalone_iot, standalone_contributors = standalone_signature[label]
                assert iot == pytest.approx(standalone_iot) if iot is not None else standalone_iot is None
                assert contributors == standalone_contributors
