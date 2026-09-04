"""Databricks workflow entry point for the SAZ pillar input loader."""

from .load_pillar_input import load_pillar_input


def main() -> None:
    records, rejected = load_pillar_input()
    print(f"Validated {len(records)} SAZ pillar input records.")
    if rejected:
        print(f"Rejected {len(rejected)} SAZ pillar input rows.")


if __name__ == "__main__":
    main()
