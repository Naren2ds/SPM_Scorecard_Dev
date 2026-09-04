"""Databricks workflow entry point for the SAZ KPI input loader."""

from .load_kpi_input import load_kpi_input


def main() -> None:
    records, rejected = load_kpi_input()
    print(f"Validated {len(records)} SAZ KPI input records.")
    if rejected:
        print(f"Rejected {len(rejected)} SAZ KPI input rows.")

if __name__ == "__main__":
	main()
