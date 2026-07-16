"""
Fetch and process Invoice Conformity KPI data from Databricks.
Usage: python backend/fetch_invoice_conformity.py

Source table: brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_conformity

Formula:
  mismatch_count = missing_po + wrong_po + wrong_invoice
  mismatch_pct = mismatch_count / total_invoices * 100
  conformity_pct = 1 - (mismatch_pct / 100)   [0-1, higher = better]

Column mapping (raw -> frontend):
  vendor_name     -> supplier
  parent_name     -> parentSupplier
  zone            -> zone
  country         -> country
  gpo_category    -> category
  missing_po      -> missingPo (raw count)
  wrong_po        -> wrongPo (raw count)
  wrong_invoice   -> wrongInvoice (raw count)
  total_invoices  -> totalInvoices (raw count)

Aggregation:
  Group by (supplier, parentSupplier, zone, country, category, kpiApplicability)
  SUM: missingPo, wrongPo, wrongInvoice, totalInvoices
  Then recalculate conformityPct from aggregated totals.

No date column — single snapshot.
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
FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_conformity
"""

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "invoice_conformity.csv"


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
    """Map columns, aggregate, calculate conformity %."""

    lower_cols = {c.lower(): c for c in df.columns}

    def col_text(name: str) -> pd.Series:
        actual = lower_cols.get(name.lower())
        if actual is None:
            return pd.Series([""] * len(df), index=df.index)
        return df[actual].astype(str).fillna("").replace("nan", "")

    def col_numeric(name: str) -> pd.Series:
        actual = lower_cols.get(name.lower())
        if actual is None:
            return pd.Series([0] * len(df), index=df.index)
        return pd.to_numeric(df[actual], errors="coerce").fillna(0)

    mapped = pd.DataFrame({
        "supplier": col_text("vendor_name"),
        "parentSupplier": col_text("parent_name"),
        "zone": col_text("zone"),
        "country": col_text("country"),
        "category": col_text("gpo_category"),
        "missingPo": col_numeric("missing_po"),
        "wrongPo": col_numeric("wrong_po"),
        "wrongInvoice": col_numeric("wrong_invoice"),
        "totalInvoices": col_numeric("total_invoices"),
    })

    mapped["kpiApplicability"] = "Applicable"

    # Aggregate: sum raw counts per supplier/dimension
    group_cols = ["supplier", "parentSupplier", "zone", "country", "category", "kpiApplicability"]
    num_cols = ["missingPo", "wrongPo", "wrongInvoice", "totalInvoices"]
    agg = mapped.groupby(group_cols, as_index=False)[num_cols].sum()

    # Calculate conformity %: (1 - mismatch_count / total_invoices)
    agg["mismatchCount"] = agg["missingPo"] + agg["wrongPo"] + agg["wrongInvoice"]
    agg["conformityPct"] = agg.apply(
        lambda r: "" if r["totalInvoices"] == 0 else f"{1 - (r['mismatchCount'] / r['totalInvoices']):.6f}",
        axis=1,
    )

    # ID + string cast numeric columns
    agg.insert(0, "id", [f"ic-{i}" for i in range(len(agg))])
    for col in num_cols + ["mismatchCount"]:
        agg[col] = agg[col].astype(int).astype(str)

    output_cols = [
        "id", "supplier", "parentSupplier", "zone", "country", "category",
        "kpiApplicability", "conformityPct",
        "missingPo", "wrongPo", "wrongInvoice", "totalInvoices", "mismatchCount",
    ]
    return agg[output_cols]


def main():
    print("Fetching Invoice Conformity data from Databricks...")
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
