"""
Fetch and process Supplier Compliance % KPI data from Databricks.
Usage: python backend/fetch_supplier_compliance.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance
              (shared with Supplier Assessment KPI)

Column mapping (raw -> frontend):
  supplier_name           -> supplier
  parent_name             -> parentSupplier
  zone                    -> zone
  country                 -> country
  supplier_category       -> category
  KPI_applicable          -> kpiApplicability   (forced "Applicable" for now)
  supplier_approval_status -> supplierApprovalStatus  (display only)
  supplier_compliance_pct -> compliancePct  (pre-computed % — direct mode)

Aggregation:
  Groups by (supplier, parentSupplier, zone, country, category,
             kpiApplicability, supplierApprovalStatus, year)
  Compliance % is a supplier-level attribute — we take the MEAN across
  duplicate rows (which almost always equals the constant supplier value).

year:
  Constant "2026" (per current business rule).
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
FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance
"""

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "supplier_compliance.csv"

# Constant year applied to every processed row (per business rule).
CONSTANT_YEAR = "2026"


def fetch_raw() -> pd.DataFrame:
    """Fetch raw supplier compliance data from Databricks."""
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
    """Map columns, normalise compliance %, aggregate per supplier."""

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
        "country": col_text("country"),
        "category": col_text("supplier_category"),
        "supplierApprovalStatus": col_text("supplier_approval_status"),
        "compliancePctRaw": col_numeric("supplier_compliance_pct"),
    })

    # Constants per business rule
    mapped["kpiApplicability"] = "Applicable"
    mapped["year"] = CONSTANT_YEAR

    # Normalise the raw value into the [0, 1] range so the frontend can display
    # it consistently. Values already in [0, 1] pass through; values in
    # (1, 100] are treated as percentages and divided by 100. Values outside
    # both ranges become NaN (frontend flags as Missing / Invalid).
    def _normalise_pct(value):
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

    mapped["compliancePct"] = mapped["compliancePctRaw"].apply(_normalise_pct)
    # Force numeric dtype so groupby().mean() can aggregate cleanly
    # (apply returns object dtype when mixing floats with pd.NA).
    mapped["compliancePct"] = pd.to_numeric(mapped["compliancePct"], errors="coerce")

    # Aggregate to one row per unique supplier/dimension combo. The mean of
    # a constant value is that value; if duplicates disagree, mean is the
    # safest neutral aggregation.
    group_cols = [
        "year", "supplier", "parentSupplier", "zone", "country", "category",
        "kpiApplicability", "supplierApprovalStatus",
    ]
    agg = (
        mapped.groupby(group_cols, dropna=False, as_index=False)["compliancePct"]
        .mean()
    )

    # id + string-cast (keep CSV all-strings for stable API)
    agg.insert(0, "id", [f"sc-{i}" for i in range(len(agg))])
    agg["compliancePct"] = agg["compliancePct"].apply(
        lambda v: "" if pd.isna(v) else f"{float(v):.6f}"
    )

    # Final column order
    output_cols = [
        "id",
        "supplier", "parentSupplier", "zone", "country", "category",
        "kpiApplicability", "supplierApprovalStatus",
        "compliancePct",
        "year",
    ]
    return agg[output_cols]


def main():
    print("Fetching Supplier Compliance data from Databricks...")
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
