"""
Temporary export script (NOT part of the pipeline codebase).
Runs the SAZ supplier spend loader against Databricks and exports results via export_utils.
Delete after loader review is complete.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from export_utils import export_records

from data_pipeline.saz.load_supplier_spend.load_supplier_spend import load_supplier_spend


def main() -> None:
    records, rejected = load_supplier_spend()
    export_records("supplier_spend", records, rejected)


if __name__ == "__main__":
    main()
