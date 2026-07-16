"""
Fetch and process CO2 Emission KPI data from Databricks.
Usage: python backend/fetch_co2_emission.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance

Column mapping (raw -> frontend):
  supplier_name         -> supplier
  parent_name           -> parentSupplier
  zone                  -> zone
  supplier_category     -> category
  KPI_applicable        -> kpiApplicability   (forced "Applicable" for now)
  emissions_tco2e_2024  -> co2Emission        (absolute tonnes CO2 equivalent,
                                                interpreted as "CO2 Reduction
                                                Potential" -- higher is better)

Aggregation:
  Groups by (supplier, parentSupplier, zone, category, kpiApplicability, year)
  and takes the MEAN of co2Emission across duplicate rows (constant per
  supplier under normal circumstances).

year:
  Constant "2024" (source column is emissions_tco2e_2024 -- year is baked in).
"""

import os
from pathlib import Path

import pandas as pd
from databricks import sql
from dotenv import load_dotenv

# Load credentials from backend/.env
load_dotenv(Path(__file__).parent / ".env")

SERVER_HOSTNAME = os.environ["DATABRICKS_SERVER_HOSTNAME"]
HTTP_PATH = os.environ["DATABRICKS_HTTP_PATH"]
TOKEN = os.environ["DATABRICKS_TOKEN"]

QUERY = """
SELECT *
FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
"""

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "co2_emission.csv"

# Constant year applied to every processed row (source column is
# emissions_tco2e_2024, so all rows are inherently year 2024).
CONSTANT_YEAR = "2024"


def fetch_raw() -> pd.DataFrame:
    """Fetch raw CO2 Emission data from Databricks."""
    with sql.connect(
        server_hostname=SERVER_HOSTNAME,
        http_path=HTTP_PATH,
        access_token=TOKEN,
        use_cloud_fetch=False,
    ) as conn:
        with conn.cursor() as cursor:
            cursor.execute(QUERY)
            rows = cursor.fetchall()
            columns = [col[0] for col in cursor.description]
    return pd.DataFrame(rows, columns=columns)


def process(df: pd.DataFrame) -> pd.DataFrame:
    """Map columns and aggregate per supplier."""

    # Case-insensitive column lookup so schema variations survive.
    lower_cols = {c.lower(): c for c in df.columns}

    def col_text(name: str) -> pd.Series:
        actual = lower_cols.get(name.lower())
        if actual is None:
            return pd.Series([""] * len(df), index=df.index)
        return df[actual].astype(str).fillna("").replace("nan", "")

    def col_numeric(name: str) -> pd.Series:
        actual = lower_cols.get(name.lower())
        if actual is None:
            return pd.Series([pd.NA] * len(df), index=df.index, dtype="Float64")
        return pd.to_numeric(df[actual], errors="coerce")

    mapped = pd.DataFrame({
        "supplier": col_text("supplier_name"),
        "parentSupplier": col_text("parent_name"),
        "zone": col_text("zone"),
        "category": col_text("supplier_category"),
        "co2Emission": col_numeric("emissions_tco2e_2024"),
    })

    # Constants per business rule
    mapped["kpiApplicability"] = "Applicable"
    mapped["year"] = CONSTANT_YEAR

    # Aggregate to one row per unique supplier/dimension combo.
    group_cols = [
        "year", "supplier", "parentSupplier", "zone", "category",
        "kpiApplicability",
    ]
    agg = (
        mapped.groupby(group_cols, dropna=False, as_index=False)["co2Emission"]
        .mean()
    )

    # id + string-cast (keep CSV all-strings for stable API)
    agg.insert(0, "id", [f"co2-{i}" for i in range(len(agg))])
    agg["co2Emission"] = agg["co2Emission"].apply(
        lambda v: "" if pd.isna(v) else f"{float(v):.6f}"
    )

    # Final column order
    output_cols = [
        "id",
        "supplier", "parentSupplier", "zone", "category",
        "kpiApplicability",
        "co2Emission",
        "year",
    ]
    return agg[output_cols]


def main():
    print("Fetching CO2 Emission data from Databricks...")
    raw = fetch_raw()
    print(f"Raw rows: {len(raw)}")

    processed = process(raw)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    processed.to_csv(OUTPUT_PATH, index=False)

    print(f"Processed rows: {len(processed)}")
    print(f"Output: {OUTPUT_PATH}")
    print(processed.head(10).to_string(index=False))


if __name__ == "__main__":
    main()
