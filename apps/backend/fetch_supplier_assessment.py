"""
Fetch and process Supplier Assessment (Quality) KPI data from Databricks.
Usage: python backend/fetch_supplier_assessment.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance

Column mapping (raw -> frontend):
  supplier_name           -> supplier
  parent_name             -> parentSupplier
  zone                    -> zone
  country                 -> country
  supplier_category       -> category
  KPI_applicable          -> kpiApplicability   (forced "Applicable" for now)
  supplier_approval_status -> supplierApprovalStatus  (display only)
  annual_assessment       -> categorised into Green / Yellow / Red / N/A / Blank counts

Aggregation:
  Groups by (supplier, parentSupplier, zone, country, category,
             kpiApplicability, supplierApprovalStatus, year)
  Counts each row's annual_assessment as green / yellow / red / na / blank.

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

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "supplier_assessment.csv"

# Constant year applied to every processed row (per business rule).
CONSTANT_YEAR = "2026"


def fetch_raw() -> pd.DataFrame:
    """Fetch raw supplier assessment data from Databricks."""
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


def _categorise_rating(value) -> str:
    """Map raw annual_assessment value to green | yellow | red | na | blank."""
    if value is None:
        return "blank"
    key = str(value).strip().lower()
    if not key or key in {"blank", "(blank)"}:
        return "blank"
    if key in {"green", "g"}:
        return "green"
    if key in {"yellow", "amber", "y"}:
        return "yellow"
    if key in {"red", "r"}:
        return "red"
    if key in {"n/a", "na", "not applicable", "not-applicable"}:
        return "na"
    # unknown value — treat as blank so pipeline stays robust
    return "blank"


def process(df: pd.DataFrame) -> pd.DataFrame:
    """Map columns, categorise assessments, aggregate to counts per supplier."""

    # Step 1: Column mapping (case-insensitive lookup so schema variations survive)
    lower_cols = {c.lower(): c for c in df.columns}

    def col(name: str) -> pd.Series:
        actual = lower_cols.get(name.lower())
        if actual is None:
            return pd.Series([""] * len(df), index=df.index)
        return df[actual].astype(str).fillna("").replace("nan", "")

    mapped = pd.DataFrame({
        "supplier": col("supplier_name"),
        "parentSupplier": col("parent_name"),
        "zone": col("zone"),
        "country": col("country"),
        "category": col("supplier_category"),
        "scorecard_category": col("scorecard_category"),
        "supplierApprovalStatus": col("supplier_approval_status"),
        "rating": col("annual_assessment"),
    })

    # Step 2: Constants per business rule
    mapped["kpiApplicability"] = "Applicable"
    mapped["year"] = CONSTANT_YEAR

    # Step 3: Categorise raw rating -> green/yellow/red/na/blank
    mapped["ratingCategory"] = mapped["rating"].apply(_categorise_rating)

    # Step 4: One-hot columns per category (integer 0/1) for summable aggregation
    for cat in ("green", "yellow", "red", "na", "blank"):
        mapped[cat] = (mapped["ratingCategory"] == cat).astype(int)

    # Step 5: Aggregate to counts per unique supplier / dimension combo
    group_cols = [
        "year", "supplier", "parentSupplier", "zone", "country", "category",
        "scorecard_category",
        "kpiApplicability", "supplierApprovalStatus",
    ]
    count_cols = ["green", "yellow", "red", "na", "blank"]
    agg = mapped.groupby(group_cols, as_index=False)[count_cols].sum()

    # Step 6: Rename to camelCase count fields the frontend expects
    agg = agg.rename(columns={
        "green": "greenCount",
        "yellow": "yellowCount",
        "red": "redCount",
        "na": "naCount",
        "blank": "blankCount",
    })

    # Step 7: id + string-cast numeric counts (keep CSV all-strings for stable API)
    agg.insert(0, "id", [f"sa-{i}" for i in range(len(agg))])
    for c in ["greenCount", "yellowCount", "redCount", "naCount", "blankCount"]:
        agg[c] = agg[c].astype(int).astype(str)

    # Step 8: Final column order
    output_cols = [
        "id",
        "supplier", "parentSupplier", "zone", "country", "category", "scorecard_category",
        "kpiApplicability", "supplierApprovalStatus",
        "greenCount", "yellowCount", "redCount", "naCount", "blankCount",
        "year",
    ]
    return agg[output_cols]


def main():
    print("Fetching Supplier Assessment data from Databricks...")
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
