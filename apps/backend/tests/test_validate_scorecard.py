"""
Pytest wrapper for the full scorecard integration validation.

Calls run_validation() from validate_scorecard.py and asserts ALL PASS.

NOTE: This test reads all CSV files from apps/backend/data/ and checks
every parent supplier — it is slower than unit tests (~10-30s).

Run all tests:
    cd apps/backend
    python -m pytest tests/ -v

Run only this integration test:
    python -m pytest tests/test_validate_scorecard.py -v

Run only fast unit tests (skip this file):
    python -m pytest tests/ -v --ignore=tests/test_validate_scorecard.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from validate_scorecard import run_validation


def test_all_scorecard_calculations_pass():
    """
    Full integration test: independently recomputes every KPI earned score
    for every parent supplier and asserts they all match compute_scorecard().

    Fails if any KPI field differs by more than TOLERANCE (0.001) or
    any normalized score differs by more than TOLERANCE_SCORE (0.005).
    """
    passed = run_validation()
    assert passed, (
        "Scorecard validation FAILED — one or more KPI calculations do not match. "
        "Check the newest apps/backend/data/"
        "scorecard_validation_report_YYYYMMDD_HHMMSS.xlsx file for details."
    )
