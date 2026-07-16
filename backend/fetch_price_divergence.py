"""
Fetch and process Price Divergence KPI data from Databricks.
Usage: python backend/fetch_price_divergence.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_price_divergence

Formula:
  Price Divergence % = ABS(SUM(invoice_value) - SUM(po_value)) / SUM(po_value)
  Lower is better.

Column mapping (raw -> frontend):
  vendor_name     -> supplier
  parent_name     -> parentSupplier
  zone            -> zone
  country         -> country
  gpo_category    -> category
  delivery_month  -> year, month
  total_po_value  -> poValue (summed)
  total_invoice_value -> invoiceValue (summed)

Aggregation:
  Group by (year, month, supplier, parentSupplier, zone, country, category)
  SUM: poValue, invoiceValue
  Then calculate divergencePct = abs(invoiceValue - poValue) / poValue
"""

import os
from pathlib import Path

import pandas as pd
from databricks import sql
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

SERVER_HOSTNAME = os.environ["DATABRICKS_SERVER_HOSTNAME"]
HTTP_PATH = os.environ["DATABRICKS_HTTP_PATH"]
TOKEN = os.environ["DATABRICKS_TOKEN"]

QUERY = """
SELECT *
FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_price_divergence
"""

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "price_divergence.csv"


def fetch_raw() -> pd.DataFrame:
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
    mapped = df.rename(columns={
        "vendor_name": "supplier",
        "parent_name": "parentSupplier",
        "zone": "zone",
        "country": "country",
        "gpo_category": "category",
        "total_po_value": "poValue",
        "total_invoice_value": "invoiceValue",
    })

    # Fill NaN
    mapped["supplier"] = mapped["supplier"].fillna("").astype(str)
    mapped["parentSupplier"] = mapped["parentSupplier"].fillna("").astype(str)
    mapped["zone"] = mapped["zone"].fillna("").astype(str)
    mapped["country"] = mapped["country"].fillna("").astype(str)
    mapped["category"] = mapped["category"].fillna("").astype(str)

    # Extract year and month from delivery_month (YYYY-MM)
    mapped["year"] = mapped["delivery_month"].astype(str).str[:4]
    mapped["month"] = mapped["delivery_month"].astype(str).str[5:7].str.lstrip("0")

    # Ensure numeric
    mapped["poValue"] = pd.to_numeric(mapped["poValue"], errors="coerce").fillna(0)
    mapped["invoiceValue"] = pd.to_numeric(mapped["invoiceValue"], errors="coerce").fillna(0)

    # Aggregate
    group_cols = ["year", "month", "supplier", "parentSupplier", "zone", "country", "category"]
    agg = mapped.groupby(group_cols, as_index=False)[["poValue", "invoiceValue"]].sum()

    # Calculate Price Divergence %: abs(invoice - po) / po
    agg["divergencePct"] = agg.apply(
        lambda r: abs(r["invoiceValue"] - r["poValue"]) / r["poValue"] if r["poValue"] > 0 else None,
        axis=1,
    )

    # Add metadata
    agg.insert(0, "id", [f"pd-{i}" for i in range(len(agg))])
    agg["kpiApplicability"] = "Applicable"

    # Convert to strings for CSV
    agg["poValue"] = agg["poValue"].apply(lambda v: f"{v:.2f}")
    agg["invoiceValue"] = agg["invoiceValue"].apply(lambda v: f"{v:.2f}")
    agg["divergencePct"] = agg["divergencePct"].apply(
        lambda v: "" if pd.isna(v) else f"{v:.6f}"
    )

    output_cols = [
        "id", "supplier", "parentSupplier", "zone", "country", "category",
        "kpiApplicability", "poValue", "invoiceValue", "divergencePct", "year", "month",
    ]
    return agg[output_cols]


def main():
    print("Fetching Price Divergence data from Databricks...")
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
