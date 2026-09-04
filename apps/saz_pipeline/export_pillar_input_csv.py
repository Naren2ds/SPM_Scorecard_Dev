"""
Temporary export script (NOT part of the pipeline codebase).
Runs the SAZ pillar input loader against Databricks and exports results via export_utils.
Delete after loader review is complete.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from export_utils import export_records

from data_pipeline.saz.load_pillar_input.load_pillar_input import load_pillar_input


def main() -> None:
    records, rejected = load_pillar_input()
    export_records("pillar_input", records, rejected)


if __name__ == "__main__":
    main()
