"""Databricks workflow entry point for the SAZ scorecard input loader."""

from .load_scorecard_input import load_scorecard_input


def main() -> None:
    records, rejected = load_scorecard_input()
    print(f"Validated {len(records)} SAZ scorecard input records.")
    if rejected:
        print(f"Rejected {len(rejected)} SAZ scorecard input rows.")


if __name__ == "__main__":
    main()
