"""Internal, all-or-nothing Databricks refresh for scorecard CSV data."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType

import pandas as pd
from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
ENV_PATH = BACKEND_DIR / ".env"
MANIFEST_PATH = DATA_DIR / "refresh_manifest.json"
REQUIRED_ENV_VARS = (
    "DATABRICKS_SERVER_HOSTNAME",
    "DATABRICKS_HTTP_PATH",
    "DATABRICKS_TOKEN",
)


@dataclass(frozen=True)
class Dataset:
    key: str
    label: str
    module_name: str
    filename: str


DATASETS = (
    Dataset("dot", "DOT", "fetch_dot_kpi", "dot_kpi.csv"),
    Dataset("iot", "IOT", "fetch_iot_kpi", "iot_kpi.csv"),
    Dataset(
        "supplier_assessment",
        "Supplier Assessment",
        "fetch_supplier_assessment",
        "supplier_assessment.csv",
    ),
    Dataset(
        "supplier_compliance",
        "Supplier Compliance",
        "fetch_supplier_compliance",
        "supplier_compliance.csv",
    ),
    Dataset(
        "supplier_maturity",
        "Supplier Maturity",
        "fetch_supplier_maturity",
        "supplier_maturity.csv",
    ),
    Dataset("co2", "CO2 Emission", "fetch_co2_emission", "co2_emission.csv"),
    Dataset("eclipse", "Eclipse", "fetch_eclipse", "eclipse.csv"),
    Dataset(
        "invoice_conformity",
        "Invoice Conformity",
        "fetch_invoice_conformity",
        "invoice_conformity.csv",
    ),
    Dataset(
        "price_divergence",
        "Price Divergence",
        "fetch_price_divergence",
        "price_divergence.csv",
    ),
)


class RefreshError(RuntimeError):
    """Raised when refresh or validation cannot complete safely."""


def load_environment() -> dict[str, str]:
    """Load local credentials without printing their values."""
    load_dotenv(ENV_PATH)
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name, "").strip()]
    if missing:
        names = ", ".join(missing)
        raise RefreshError(
            f"Missing Databricks configuration: {names}. "
            f"Create {ENV_PATH} from {BACKEND_DIR / '.env.example'}."
        )
    return {name: os.environ[name].strip() for name in REQUIRED_ENV_VARS}


def count_csv_rows(path: Path) -> int:
    """Count CSV data rows without loading the existing file into memory."""
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return max(sum(1 for _ in handle) - 1, 0)


def validate_frame(
    dataset: Dataset,
    frame: pd.DataFrame,
    current_path: Path,
    min_row_ratio: float,
) -> dict[str, int | float]:
    """Validate schema, identifiers, and unexpected row-count drops."""
    if not isinstance(frame, pd.DataFrame):
        raise RefreshError(f"{dataset.label}: process() did not return a DataFrame.")
    if frame.empty:
        raise RefreshError(f"{dataset.label}: processed dataset is empty.")
    if not current_path.exists():
        raise RefreshError(f"{dataset.label}: current CSV is missing: {current_path}")

    expected_columns = list(pd.read_csv(current_path, nrows=0).columns)
    actual_columns = list(frame.columns)
    if actual_columns != expected_columns:
        missing = [column for column in expected_columns if column not in actual_columns]
        extra = [column for column in actual_columns if column not in expected_columns]
        raise RefreshError(
            f"{dataset.label}: schema mismatch. "
            f"Missing={missing or 'none'}, extra={extra or 'none'}, "
            "or column order changed."
        )

    for column in ("id", "parentSupplier", "kpiApplicability"):
        values = frame[column].fillna("").astype(str).str.strip()
        if values.eq("").all():
            raise RefreshError(f"{dataset.label}: column {column!r} is entirely empty.")

    identifiers = frame["id"].fillna("").astype(str).str.strip()
    if identifiers.eq("").any():
        raise RefreshError(f"{dataset.label}: one or more rows have an empty id.")
    duplicate_count = int(identifiers.duplicated().sum())
    if duplicate_count:
        raise RefreshError(f"{dataset.label}: found {duplicate_count} duplicate ids.")

    previous_rows = count_csv_rows(current_path)
    refreshed_rows = len(frame)
    row_ratio = refreshed_rows / previous_rows if previous_rows else 1.0
    if previous_rows and row_ratio < min_row_ratio:
        raise RefreshError(
            f"{dataset.label}: row count dropped from {previous_rows:,} to "
            f"{refreshed_rows:,} ({row_ratio:.1%}); minimum allowed is "
            f"{min_row_ratio:.1%}. Use --allow-large-row-count-change only "
            "after verifying the source data."
        )

    return {
        "previous_rows": previous_rows,
        "refreshed_rows": refreshed_rows,
        "row_ratio": round(row_ratio, 6),
    }


def import_connector(dataset: Dataset) -> ModuleType:
    try:
        module = importlib.import_module(dataset.module_name)
    except Exception as exc:
        raise RefreshError(f"{dataset.label}: connector import failed: {exc}") from exc

    for function_name in ("fetch_raw", "process"):
        if not callable(getattr(module, function_name, None)):
            raise RefreshError(
                f"{dataset.label}: connector is missing {function_name}()."
            )
    return module


def check_connection(settings: dict[str, str]) -> None:
    """Run a minimal query without exposing credentials."""
    try:
        from databricks import sql

        with sql.connect(
            server_hostname=settings["DATABRICKS_SERVER_HOSTNAME"],
            http_path=settings["DATABRICKS_HTTP_PATH"],
            access_token=settings["DATABRICKS_TOKEN"],
            use_cloud_fetch=False,
        ) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                result = cursor.fetchone()
    except Exception as exc:
        raise RefreshError(f"Databricks connection check failed: {exc}") from exc

    if not result or result[0] != 1:
        raise RefreshError(f"Databricks connection returned an unexpected result: {result!r}")
    print("Databricks connection check: PASS")


def publish_files(files: list[tuple[Path, Path]], staging_dir: Path) -> None:
    """Replace all outputs and restore previous files if publication fails."""
    backup_dir = staging_dir / "backup"
    backup_dir.mkdir()
    backups: dict[Path, Path | None] = {}
    published: list[Path] = []

    for _, target in files:
        if target.exists():
            backup = backup_dir / target.name
            shutil.copy2(target, backup)
            backups[target] = backup
        else:
            backups[target] = None

    try:
        for source, target in files:
            os.replace(source, target)
            published.append(target)
    except Exception as exc:
        for target in reversed(published):
            backup = backups[target]
            if backup is not None and backup.exists():
                os.replace(backup, target)
            elif target.exists():
                target.unlink()
        raise RefreshError(f"Publishing refreshed files failed; old files restored: {exc}") from exc


def refresh_all(min_row_ratio: float) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=".refresh-", dir=DATA_DIR))
    staged_files: list[tuple[Path, Path]] = []
    manifest_datasets: dict[str, dict[str, int | float]] = {}

    try:
        for dataset in DATASETS:
            print(f"[{dataset.label}] Fetching from Databricks...")
            connector = import_connector(dataset)
            try:
                raw = connector.fetch_raw()
                if not isinstance(raw, pd.DataFrame) or raw.empty:
                    raise RefreshError(f"{dataset.label}: Databricks returned no rows.")
                processed = connector.process(raw)
            except RefreshError:
                raise
            except Exception as exc:
                raise RefreshError(f"{dataset.label}: refresh failed: {exc}") from exc

            current_path = DATA_DIR / dataset.filename
            result = validate_frame(dataset, processed, current_path, min_row_ratio)
            staged_path = staging_dir / dataset.filename
            processed.to_csv(staged_path, index=False)
            staged_files.append((staged_path, current_path))
            manifest_datasets[dataset.key] = result
            print(
                f"[{dataset.label}] PASS: {result['refreshed_rows']:,} rows "
                f"(previously {result['previous_rows']:,})"
            )

        manifest = {
            "refreshed_at_utc": datetime.now(timezone.utc).isoformat(),
            "dataset_count": len(DATASETS),
            "datasets": manifest_datasets,
        }
        staged_manifest = staging_dir / MANIFEST_PATH.name
        staged_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        staged_files.append((staged_manifest, MANIFEST_PATH))

        publish_files(staged_files, staging_dir)
        print(f"Published {len(DATASETS)} refreshed CSV files.")
        print(f"Manifest: {MANIFEST_PATH}")
        print("Next: python -m pytest apps/backend/tests -q")
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh and safely publish all scorecard CSVs from Databricks."
    )
    parser.add_argument(
        "--check-connection",
        action="store_true",
        help="Run SELECT 1 and exit without refreshing data.",
    )
    parser.add_argument(
        "--allow-large-row-count-change",
        action="store_true",
        help="Disable the default 50%% row-count drop safety check.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        settings = load_environment()
        if args.check_connection:
            check_connection(settings)
            return 0
        min_row_ratio = 0.0 if args.allow_large_row_count_change else 0.5
        refresh_all(min_row_ratio)
        return 0
    except RefreshError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
