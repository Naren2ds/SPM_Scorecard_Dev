from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd
import pytest

from dot_read_model import DotConfig, build_dot_read_model, query_dot_results


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "dot_kpi.csv"


@pytest.fixture(scope="module")
def current_data_model():
    if not DATA_PATH.exists():
        pytest.skip("Current DOT CSV is not available.")
    rows = pd.read_csv(DATA_PATH, dtype=str).fillna("").to_dict(orient="records")
    model = build_dot_read_model(
        rows,
        DotConfig(max_score=10, critical_floor=0.7, target=0.85),
        {"years": ["2025", "2026"]},
    )
    rows_by_parent = defaultdict(list)
    for assessment in model.assessments:
        parent = str(assessment.row.get("parentSupplier") or "").strip() or "Unassigned parent"
        rows_by_parent[parent].append(assessment)
    return model, rows_by_parent


def _rollup_signature(response):
    return {
        item["label"]: (item["normalizedDot"], item["contributingRows"])
        for item in response["items"]
    }


def test_every_parent_contributor_count_matches_its_own_valid_rows(current_data_model):
    model, rows_by_parent = current_data_model
    expected = Counter()
    for parent, assessments in rows_by_parent.items():
        expected[parent] = sum(
            1
            for assessment in assessments
            if assessment.is_applicable and assessment.is_valid
        )

    assert set(model.parent_index) == set(rows_by_parent)
    for parent, result in model.parent_index.items():
        assert result.contributing_rows == expected[parent]


def test_sampled_real_parent_queries_never_return_foreign_supplier_rows(current_data_model):
    model, rows_by_parent = current_data_model
    parents = sorted(rows_by_parent)
    step = max(len(parents) // 50, 1)
    sampled_parents = parents[::step][:50]

    for parent in sampled_parents:
        response = query_dot_results(
            model,
            level="supplier",
            parents=[parent],
            page_size=max(len(rows_by_parent[parent]), 1),
        )
        assert response["total_items"] == len(rows_by_parent[parent])
        assert {item["parentSupplier"] for item in response["items"]} == {parent}


def test_sampled_real_zone_and_category_rollups_match_isolated_recalculation(current_data_model):
    model, rows_by_parent = current_data_model
    candidates = sorted(
        parent
        for parent, assessments in rows_by_parent.items()
        if 1 <= len(assessments) <= 100
    )
    step = max(len(candidates) // 20, 1)
    sampled_parents = candidates[::step][:20]

    for parent in sampled_parents:
        parent_rows = [assessment.row for assessment in rows_by_parent[parent]]
        isolated = build_dot_read_model(parent_rows, model.config)
        page_size = max(len(parent_rows), 1)

        scoped_zones = query_dot_results(
            model,
            level="zone",
            parents=[parent],
            page_size=page_size,
        )
        isolated_zones = query_dot_results(isolated, level="zone", page_size=page_size)
        scoped_categories = query_dot_results(
            model,
            level="category",
            parents=[parent],
            page_size=page_size,
        )
        isolated_categories = query_dot_results(isolated, level="category", page_size=page_size)

        scoped_zone_signature = _rollup_signature(scoped_zones)
        isolated_zone_signature = _rollup_signature(isolated_zones)
        scoped_category_signature = _rollup_signature(scoped_categories)
        isolated_category_signature = _rollup_signature(isolated_categories)
        assert scoped_zone_signature.keys() == isolated_zone_signature.keys()
        assert scoped_category_signature.keys() == isolated_category_signature.keys()
        for label, (dot, contributors) in scoped_zone_signature.items():
            isolated_dot, isolated_contributors = isolated_zone_signature[label]
            assert dot == pytest.approx(isolated_dot) if dot is not None else isolated_dot is None
            assert contributors == isolated_contributors
        for label, (dot, contributors) in scoped_category_signature.items():
            isolated_dot, isolated_contributors = isolated_category_signature[label]
            assert dot == pytest.approx(isolated_dot) if dot is not None else isolated_dot is None
            assert contributors == isolated_contributors
