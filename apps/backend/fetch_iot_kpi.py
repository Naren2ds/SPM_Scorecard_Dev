"""
Fetch and process IOT (Invoice On Time) KPI data from Databricks.
Usage: python backend/fetch_iot_kpi.py
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
FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_on_time
"""

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "iot_kpi.csv"


def fetch_raw():
    """Fetch raw IOT data from Databricks."""
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
    """Map columns, extract year/month, aggregate, and format for frontend."""

    # Step 1: Column mapping
    mapped = df.rename(columns={
        "vendor_name": "supplier",
        "parent_name": "parentSupplier",
        "zone": "zone",
        "country": "country",
        "gpo_category": "category",
        "scorecard_category": "scorecard_category",
        "invoice_on_time_count": "invoiceOnTimeCount",
        "total_po_lines": "totalPoLines",
        "iot_applicable": "kpiApplicability",
    })
    scorecard_category_col = next((c for c in df.columns if c.lower() == "scorecard_category"), None)
    mapped["scorecard_category"] = (
        df[scorecard_category_col].astype(str).fillna("").replace("nan", "")
        if scorecard_category_col is not None
        else ""
    )

    # Handle column name variations (case-insensitive match)
    col_lower = {c.lower(): c for c in mapped.columns}
    if "invoiceontimecount" not in col_lower and "invoice_ontime_count" in col_lower:
        mapped = mapped.rename(columns={col_lower["invoice_ontime_count"]: "invoiceOnTimeCount"})
    if "totalpolines" not in col_lower and "total_po_lines" in col_lower:
        mapped = mapped.rename(columns={col_lower["total_po_lines"]: "totalPoLines"})

    # Step 2: Map kpiApplicability
    if "kpiApplicability" in mapped.columns:
        mapped["kpiApplicability"] = mapped["kpiApplicability"].apply(
            lambda v: "Applicable" if str(v).strip().upper() in ("Y", "YES", "TRUE", "1") else "Not Applicable"
        )
    else:
        mapped["kpiApplicability"] = "Applicable"

    # Step 3: Extract year and month from delivery_month (format: YYYY-MM)
    if "delivery_month" in mapped.columns:
        mapped["year"] = mapped["delivery_month"].astype(str).str[:4]
        mapped["month"] = mapped["delivery_month"].astype(str).str[5:7].str.lstrip("0")
    else:
        mapped["year"] = ""
        mapped["month"] = ""

    # Step 4: Ensure numeric columns
    num_cols = ["invoiceOnTimeCount", "totalPoLines"]
    for col in num_cols:
        if col in mapped.columns:
            mapped[col] = pd.to_numeric(mapped[col], errors="coerce").fillna(0)
        else:
            mapped[col] = 0

    # Step 5: Aggregate
    group_cols = [
        "year",
        "month",
        "supplier",
        "parentSupplier",
        "zone",
        "country",
        "category",
        "scorecard_category",
        "kpiApplicability",
    ]
    # Only group by columns that exist
    valid_group_cols = [c for c in group_cols if c in mapped.columns]
    agg = mapped.groupby(valid_group_cols, as_index=False)[num_cols].sum()

    # Step 6: Generate ID and convert numerics to string
    agg.insert(0, "id", [f"iot-{i}" for i in range(len(agg))])
    for col in num_cols:
        agg[col] = agg[col].astype(int).astype(str)

    # Step 7: Final column order
    output_cols = [
        "id", "supplier", "parentSupplier", "zone", "country", "category", "scorecard_category",
        "kpiApplicability", "invoiceOnTimeCount", "totalPoLines", "year", "month",
    ]
    for col in output_cols:
        if col not in agg.columns:
            agg[col] = ""
    return agg[output_cols]


def main():
    print("Fetching IOT KPI data from Databricks...")
    raw = fetch_raw()
    print(f"Raw rows: {len(raw)}")
    print(f"Raw columns: {list(raw.columns)}")

    processed = process(raw)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    processed.to_csv(OUTPUT_PATH, index=False)

    print(f"Processed rows: {len(processed)}")
    print(f"Output: {OUTPUT_PATH}")
    print(processed.head(10).to_string(index=False))


if __name__ == "__main__":
    main()
