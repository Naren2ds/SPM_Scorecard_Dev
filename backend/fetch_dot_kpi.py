"""
Fetch and process DOT KPI data from Databricks.
Usage: python backend/fetch_dot_kpi.py
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
FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_delivery_performance
WHERE vendor_name = 'Benepack'
"""

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "frontend" / "public" / "data" / "dot_kpi.csv"


def fetch_raw():
    """Fetch raw data from Databricks."""
    with sql.connect(
        server_hostname=SERVER_HOSTNAME,
        http_path=HTTP_PATH,
        access_token=TOKEN,
    ) as conn:
        with conn.cursor() as cursor:
            cursor.execute(QUERY)
            rows = cursor.fetchall()
            columns = [col[0] for col in cursor.description]
    return pd.DataFrame(rows, columns=columns)


def process(df: pd.DataFrame) -> pd.DataFrame:
    """Map columns, extract year/month, aggregate, and format for frontend."""

    # Step 1: Column mapping
    mapped = df.rename(columns={
        "vendor_name": "supplier",
        "parent_name": "parentSupplier",
        "zone": "zone",
        "country": "country",
        "gpo_category": "category",
        "on_time_delivered": "onTimePoLines",
        "total_delivered": "totalDeliveredPoLines",
        "x1_overdue": "x1DelayedOver30Days",
        "x2_future_due": "x2EarlyOver30Days",
        "dot_applicable": "kpiApplicability",
    })

    # Step 2: Map kpiApplicability
    mapped["kpiApplicability"] = mapped["kpiApplicability"].apply(
        lambda v: "Applicable" if str(v).strip().upper() == "Y" else "Not Applicable"
    )

    # Step 3: Extract year and month from delivery_month (format: YYYY-MM)
    mapped["year"] = mapped["delivery_month"].astype(str).str[:4]
    mapped["month"] = mapped["delivery_month"].astype(str).str[5:7]

    # Step 4: Ensure numeric columns
    num_cols = ["onTimePoLines", "totalDeliveredPoLines", "x1DelayedOver30Days", "x2EarlyOver30Days"]
    for col in num_cols:
        mapped[col] = pd.to_numeric(mapped[col], errors="coerce").fillna(0)

    # Step 5: Aggregate
    group_cols = ["year", "month", "supplier", "parentSupplier", "zone", "country", "category", "kpiApplicability"]
    agg = mapped.groupby(group_cols, as_index=False)[num_cols].sum()

    # Step 6: Leave dotPercent empty (frontend calculates from raw values)
    agg["dotPercent"] = ""

    # Step 7: Generate ID and convert numerics to string
    agg.insert(0, "id", [f"dot-{i}" for i in range(len(agg))])
    for col in num_cols:
        agg[col] = agg[col].astype(int).astype(str)

    # Step 8: Final column order
    output_cols = [
        "id", "supplier", "parentSupplier", "zone", "country", "category",
        "kpiApplicability", "dotPercent", "onTimePoLines", "totalDeliveredPoLines",
        "x1DelayedOver30Days", "x2EarlyOver30Days", "year", "month",
    ]
    return agg[output_cols]


def main():
    print("Fetching DOT KPI data from Databricks...")
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
