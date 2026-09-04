"""
Temporary CSV export helper (NOT part of the pipeline codebase).
Writes validated and rejected records from any SAZ loader to data/*.csv for manual review.
Delete this file, and every export_*.py script that uses it, once loader review is complete.
"""

from pathlib import Path

import pandas as pd
from pydantic import BaseModel

DATA_DIR = Path(__file__).resolve().parent / "data"


def export_records(
    name: str,
    records: list[BaseModel],
    rejected: list[dict],
) -> None:
    """Write valid records to data/{name}.csv and rejected rows to data/{name}_rejected.csv."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    output_path = DATA_DIR / f"{name}.csv"
    pd.DataFrame([record.model_dump() for record in records]).to_csv(output_path, index=False)
    print(f"Validated {len(records)} records -> {output_path}")

    if rejected:
        rejected_path = DATA_DIR / f"{name}_rejected.csv"
        pd.DataFrame(rejected).to_csv(rejected_path, index=False)
        print(f"Rejected {len(rejected)} rows -> {rejected_path}")
    else:
        print("Rejected 0 rows.")
