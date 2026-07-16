"""
Fetch and process Eclipse Score KPI data from Databricks.
Usage: python backend/fetch_eclipse.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance

Column mapping (raw -> frontend):
  supplier_name       -> supplier
  parent_name         -> parentSupplier
  zone                -> zone
  category            -> category
  eclipse_score_2025  -> eclipseScore (raw 0-100 -> normalised to [0, 1])

Normalisation:
  0-1   -> keep as-is (already a ratio)
  1-100 -> divide by 100
  <0 or >100 -> invalid (empty string)

Aggregation:
  Groups by (supplier, parentSupplier, zone, category, kpiApplicability, year)
  and takes MEAN of eclipseScore.

year: Constant "2025" (source column is eclipse_score_2025).
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

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "eclipse.csv"

CONSTANT_YEAR = "2025"


def fetch_raw() -> pd.DataFrame:
    """Fetch raw data from Databricks."""
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
    """Map columns, normalise eclipse score, aggregate per supplier."""

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

    category_col = lower_cols.get("supplier_category") or lower_cols.get("category")
    category_series = (
        df[category_col].astype(str).fillna("").replace("nan", "")
        if category_col else pd.Series([""] * len(df), index=df.index)
    )

    mapped = pd.DataFrame({
        "supplier": col_text("supplier_name"),
        "parentSupplier": col_text("parent_name"),
        "zone": col_text("zone"),
        "category": category_series,
        "eclipseScoreRaw": col_numeric("eclipse_score_2025"),
    })

    mapped["kpiApplicability"] = "Applicable"
    mapped["year"] = CONSTANT_YEAR

    # Normalise: 0-1 keep, 1-100 divide by 100, else invalid
    def _normalise(value):
        if pd.isna(value):
            return pd.NA
        try:
            v = float(value)
        except (TypeError, ValueError):
            return pd.NA
        if v < 0 or v > 100:
            return pd.NA
        if 0 <= v <= 1:
            return v
        return v / 100.0

    mapped["eclipseScore"] = mapped["eclipseScoreRaw"].apply(_normalise)
    mapped["eclipseScore"] = pd.to_numeric(mapped["eclipseScore"], errors="coerce")

    # Aggregate
    group_cols = ["year", "supplier", "parentSupplier", "zone", "category", "kpiApplicability"]
    agg = mapped.groupby(group_cols, dropna=False, as_index=False)["eclipseScore"].mean()

    # ID + string cast
    agg.insert(0, "id", [f"ecl-{i}" for i in range(len(agg))])
    agg["eclipseScore"] = agg["eclipseScore"].apply(
        lambda v: "" if pd.isna(v) else f"{float(v):.6f}"
    )

    output_cols = ["id", "supplier", "parentSupplier", "zone", "category", "kpiApplicability", "eclipseScore", "year"]
    for col in output_cols:
        if col not in agg.columns:
            agg[col] = ""
    return agg[output_cols]


def main():
    print("Fetching Eclipse Score data from Databricks...")
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
