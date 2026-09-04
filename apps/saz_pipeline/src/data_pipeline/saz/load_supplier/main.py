"""Databricks workflow entry point for the SAZ supplier loader."""

from .load_supplier import load_supplier


def main() -> None:
    records, rejected = load_supplier()
    print(f"Validated {len(records)} SAZ supplier records.")
    if rejected:
        print(f"Rejected {len(rejected)} SAZ supplier rows.")

if __name__ == "__main__":
	main()
