"""Databricks workflow entry point for the SAZ supplier spend loader."""

from .load_supplier_spend import load_supplier_spend


def main() -> None:
    records, rejected = load_supplier_spend()
    print(f"Validated {len(records)} SAZ supplier spend records.")
    if rejected:
        print(f"Rejected {len(rejected)} SAZ supplier spend rows.")


if __name__ == "__main__":
    main()
