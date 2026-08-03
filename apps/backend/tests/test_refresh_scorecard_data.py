"""Unit tests for the internal Databricks refresh safety checks."""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from refresh_scorecard_data import Dataset, RefreshError, validate_frame


DATASET = Dataset("example", "Example", "unused", "example.csv")
COLUMNS = ["id", "parentSupplier", "kpiApplicability", "value"]


def _frame(row_count: int) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "id": [f"row-{index}" for index in range(row_count)],
            "parentSupplier": ["Parent"] * row_count,
            "kpiApplicability": ["Applicable"] * row_count,
            "value": list(range(row_count)),
        }
    )[COLUMNS]


def _write_current(path: Path, row_count: int = 10) -> None:
    _frame(row_count).to_csv(path, index=False)


def test_validate_frame_accepts_compatible_data(tmp_path: Path):
    current = tmp_path / "example.csv"
    _write_current(current)

    result = validate_frame(DATASET, _frame(12), current, min_row_ratio=0.5)

    assert result["previous_rows"] == 10
    assert result["refreshed_rows"] == 12


def test_validate_frame_rejects_schema_change(tmp_path: Path):
    current = tmp_path / "example.csv"
    _write_current(current)
    changed = _frame(10).drop(columns="value")

    with pytest.raises(RefreshError, match="schema mismatch"):
        validate_frame(DATASET, changed, current, min_row_ratio=0.5)


def test_validate_frame_rejects_duplicate_ids(tmp_path: Path):
    current = tmp_path / "example.csv"
    _write_current(current)
    changed = _frame(10)
    changed.loc[1, "id"] = changed.loc[0, "id"]

    with pytest.raises(RefreshError, match="duplicate ids"):
        validate_frame(DATASET, changed, current, min_row_ratio=0.5)


def test_validate_frame_rejects_large_row_drop(tmp_path: Path):
    current = tmp_path / "example.csv"
    _write_current(current, row_count=10)

    with pytest.raises(RefreshError, match="row count dropped"):
        validate_frame(DATASET, _frame(4), current, min_row_ratio=0.5)
