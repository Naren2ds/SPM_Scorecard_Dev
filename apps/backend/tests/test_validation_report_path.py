from datetime import datetime

from validate_scorecard import DATA_DIR, _timestamped_report_path


def test_timestamped_report_path_contains_run_date_and_time():
    generated_at = datetime(2026, 8, 5, 14, 30, 12)

    report_path = _timestamped_report_path(generated_at)

    assert report_path.parent == DATA_DIR
    assert report_path.name == "scorecard_validation_report_20260805_143012.xlsx"
