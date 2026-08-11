"""
Fetch and process Supplier Maturity Score KPI data from Databricks.
Usage: python backend/fetch_supplier_maturity.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance

Column mapping (raw -> frontend):
  supplier_name                 -> supplier
  parent_name                   -> parentSupplier
  zone                          -> zone
  supplier_category             -> category
  KPI_applicable                -> kpiApplicability   (forced "Applicable" for now)
  supplier_maturity_score_2025  -> maturityScore      (raw 0-100 -> normalised to [0, 1])

Aggregation:
  Groups by (supplier, parentSupplier, zone, category, kpiApplicability, year)
  and takes MEAN of maturityScore across duplicate rows (constant per
  supplier under normal circumstances).

year:
  Constant "2025" (source column is supplier_maturity_score_2025 -- year is baked in).
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

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "supplier_maturity.csv"

# Constant year applied to every processed row (source column is
# supplier_maturity_score_2025, so all rows are inherently year 2025).
CONSTANT_YEAR = "2025"


def fetch_raw() -> pd.DataFrame:
    """Fetch raw Supplier Maturity Score data from Databricks."""
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
    """Map columns, normalise maturity score, aggregate per supplier."""

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

    # Source table exposes the column as `category` (not `supplier_category`).
    # Look up both forms so schema variations survive.
    category_col = (
        lower_cols.get("supplier_category")
        or lower_cols.get("category")
    )
    if category_col:
        category_series = df[category_col].astype(str).fillna("").replace("nan", "")
    else:
        category_series = pd.Series([""] * len(df), index=df.index)

    mapped = pd.DataFrame({
        "supplier": col_text("supplier_name"),
        "parentSupplier": col_text("parent_name"),
        "zone": col_text("zone"),
        "category": category_series,
        "scorecard_category": col_text("scorecard_category"),
        "maturityScoreRaw": col_numeric("supplier_maturity_score_2025"),
    })

    # Constants per business rule
    mapped["kpiApplicability"] = "Applicable"
    mapped["year"] = CONSTANT_YEAR

    # Normalise the raw value into the [0, 1] range. Source values are on a
    # 0-100 scale; we divide by 100. Values already in [0, 1] pass through.
    # Values outside [0, 100] become NaN (frontend flags as Invalid/Missing).
    def _normalise_score(value):
        if pd.isna(value):
            return pd.NA
        try:
            v = float(value)
        except (TypeError, ValueError):
            return pd.NA
        if v < 0:
            return pd.NA
        if 0 <= v <= 1:
            return v
        if 1 < v <= 100:
            return v / 100.0
        return pd.NA

    mapped["maturityScore"] = mapped["maturityScoreRaw"].apply(_normalise_score)
    mapped["maturityScore"] = pd.to_numeric(mapped["maturityScore"], errors="coerce")

    # Aggregate to one row per unique supplier/dimension combo.
    group_cols = [
        "year", "supplier", "parentSupplier", "zone", "category", "scorecard_category",
        "kpiApplicability",
    ]
    agg = (
        mapped.groupby(group_cols, dropna=False, as_index=False)["maturityScore"]
        .mean()
    )

    # id + string-cast (keep CSV all-strings for stable API)
    agg.insert(0, "id", [f"sm-{i}" for i in range(len(agg))])
    agg["maturityScore"] = agg["maturityScore"].apply(
        lambda v: "" if pd.isna(v) else f"{float(v):.6f}"
    )

    # Final column order
    output_cols = [
        "id",
        "supplier", "parentSupplier", "zone", "category", "scorecard_category",
        "kpiApplicability",
        "maturityScore",
        "year",
    ]
    return agg[output_cols]


def main():
    print("Fetching Supplier Maturity Score data from Databricks...")
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
