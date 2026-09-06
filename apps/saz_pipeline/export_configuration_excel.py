"""
Temporary review export (NOT part of the pipeline codebase).
Writes all in-memory SAZ configuration datasets to one Excel workbook.
Delete after business validation is complete.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from data_pipeline.saz.common.configuration import (
    KPI_DEFINITIONS,
    KPI_VERSIONS,
    PILLAR_APPLICABILITY_RULES,
    PILLAR_DEFINITIONS,
    SCORECARD_DEFINITIONS,
)

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "SAZ_Configuration_Review.xlsx"


def main() -> None:
    datasets = {
        "SCORECARD_DEFINITION": SCORECARD_DEFINITIONS,
        "PILLAR_DEFINITION": PILLAR_DEFINITIONS,
        "PILLAR_APPLICABILITY": PILLAR_APPLICABILITY_RULES,
        "KPI_DEFINITION": KPI_DEFINITIONS,
        "KPI_VERSION": KPI_VERSIONS,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(OUTPUT_PATH, engine="openpyxl") as writer:
        for sheet_name, records in datasets.items():
            pd.DataFrame([record.model_dump() for record in records]).to_excel(
                writer,
                sheet_name=sheet_name,
                index=False,
            )

    print(f"Exported configuration review workbook -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
