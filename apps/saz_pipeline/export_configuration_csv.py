"""
Temporary export script (NOT part of the pipeline codebase).
Writes the in-memory SAZ configuration data (SCORECARD_DEFINITION, PILLAR_DEFINITION,
KPI_DEFINITION) to CSV for review. These are NOT Databricks tables -- see
common/configuration.py. Delete after review is complete.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from export_utils import export_records

from data_pipeline.saz.common.configuration import (
    KPI_DEFINITIONS,
    KPI_VERSIONS,
    PILLAR_APPLICABILITY_RULES,
    PILLAR_DEFINITIONS,
    SCORECARD_DEFINITIONS,
)


def main() -> None:
    exports = [
        ("scorecard_definition", SCORECARD_DEFINITIONS),
        ("pillar_definition", PILLAR_DEFINITIONS),
        ("pillar_applicability_rule", PILLAR_APPLICABILITY_RULES),
        ("kpi_definition", KPI_DEFINITIONS),
        ("kpi_version", KPI_VERSIONS),
    ]
    for name, records in exports:
        try:
            export_records(name, records, [])
        except PermissionError:
            print(f"Skipped {name}: file is open elsewhere (close it and re-run).")


if __name__ == "__main__":
    main()
