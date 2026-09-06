"""
Temporary review export (NOT part of the pipeline codebase).
Exports live SAZ pillar input records with category and exact source pillar-column
lineage. Delete after business validation is complete.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from data_pipeline.saz.common.base_loader import BaseDatabricksLoader
from data_pipeline.saz.common.constants import (
    MAIN_CATEGORY_TO_OPERATIONAL_COLUMN,
    MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN,
    MAIN_CATEGORY_TO_TABLE,
    SUSTAINABILITY_COLUMN,
    VALUE_CREATION_COLUMNS,
)
from data_pipeline.saz.common.source_utils import numeric_source_value, source_value
from data_pipeline.saz.load_pillar_input.load_pillar_input import transform_pillar_rows
from data_pipeline.saz.load_pillar_input.models import PillarInputRecord

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "pillar_input_review.csv"


def source_column_for_pillar(row: dict, main_category: str, pillar_id: str) -> str:
    if pillar_id == "SUSTAINABILITY":
        return SUSTAINABILITY_COLUMN
    if pillar_id == "OPERATIONAL":
        return MAIN_CATEGORY_TO_OPERATIONAL_COLUMN[main_category]
    if pillar_id == "SERVICE_LEVEL":
        return MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN[main_category]
    for column in VALUE_CREATION_COLUMNS:
        if numeric_source_value(source_value(row, column)) is not None:
            return column
    raise ValueError("No populated Value Creation source column")


def main() -> None:
    loader = BaseDatabricksLoader(PillarInputRecord)
    review_rows: list[dict] = []

    for main_category, table_name in MAIN_CATEGORY_TO_TABLE.items():
        raw = loader.fetch_raw(table_name)
        for row in raw.to_dict(orient="records"):
            for transformed in transform_pillar_rows(row, main_category):
                review_rows.append({
                    "source_main_category": main_category,
                    "source_pillar_column": source_column_for_pillar(
                        row, main_category, transformed["pillar_id"]
                    ),
                    **transformed,
                })

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(review_rows).to_csv(OUTPUT_PATH, index=False)
    print(f"Exported {len(review_rows)} pillar score records -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
