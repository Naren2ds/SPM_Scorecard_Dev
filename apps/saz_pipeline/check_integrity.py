"""
Temporary check script (NOT part of the pipeline codebase).
Runs all four SAZ loaders against Databricks and checks referential integrity
against the SAZ configuration (SCORECARD_DEFINITION, PILLAR_DEFINITION, KPI catalogue).
Delete after review is complete.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from data_pipeline.saz.common.integrity_checks import check_referential_integrity
from data_pipeline.saz.load_kpi_input.load_kpi_input import load_kpi_input
from data_pipeline.saz.load_pillar_input.load_pillar_input import load_pillar_input
from data_pipeline.saz.load_scorecard_input.load_scorecard_input import load_scorecard_input
from data_pipeline.saz.load_supplier.load_supplier import load_supplier


def main() -> None:
    suppliers, supplier_rejected = load_supplier()
    kpi_inputs, kpi_rejected = load_kpi_input()
    pillar_inputs, pillar_rejected = load_pillar_input()
    scorecard_inputs, scorecard_rejected = load_scorecard_input()

    print(f"Loaded: {len(suppliers)} suppliers, {len(kpi_inputs)} kpi_inputs, "
          f"{len(pillar_inputs)} pillar_inputs, {len(scorecard_inputs)} scorecard_inputs")
    print(f"Rejected (validation, not integrity): {len(supplier_rejected)} suppliers, "
          f"{len(kpi_rejected)} kpi_inputs, {len(pillar_rejected)} pillar_inputs, "
          f"{len(scorecard_rejected)} scorecard_inputs")
    print()

    report = check_referential_integrity(suppliers, kpi_inputs, pillar_inputs, scorecard_inputs)
    print(report.summary())


if __name__ == "__main__":
    main()
