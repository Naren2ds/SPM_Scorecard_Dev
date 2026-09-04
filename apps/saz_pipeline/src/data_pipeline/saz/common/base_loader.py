"""Shared Databricks extraction and Pydantic validation utilities for SAZ loaders."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Generic, TypeVar

import pandas as pd
from databricks import sql
from dotenv import load_dotenv
from pydantic import BaseModel, ValidationError


RecordModel = TypeVar("RecordModel", bound=BaseModel)
RawRow = Mapping[str, Any]
Transform = Callable[[RawRow], Mapping[str, Any]]


class RecordValidationError(ValueError):
    """Raised when a source row cannot be transformed into a target record."""

    def __init__(self, row_number: int, errors: list[dict[str, Any]]) -> None:
        self.row_number = row_number
        self.errors = errors
        super().__init__(f"Validation failed for source row {row_number}: {errors}")


class BaseDatabricksLoader(Generic[RecordModel]):
    """Fetch a Databricks table and validate transformed records for one target table."""

    def __init__(
        self,
        model_class: type[RecordModel],
        connection_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.model_class = model_class
        self.connection_factory = connection_factory or sql.connect

    @staticmethod
    def _load_credentials() -> dict[str, str]:
        pipeline_root = Path(__file__).resolve().parents[4]
        load_dotenv(pipeline_root.parent / "backend" / ".env")

        required_variables = (
            "DATABRICKS_SERVER_HOSTNAME",
            "DATABRICKS_HTTP_PATH",
            "DATABRICKS_TOKEN",
        )
        missing = [name for name in required_variables if not os.getenv(name)]
        if missing:
            raise RuntimeError(
                "Missing Databricks environment variables: " + ", ".join(missing)
            )

        return {
            "server_hostname": os.environ["DATABRICKS_SERVER_HOSTNAME"],
            "http_path": os.environ["DATABRICKS_HTTP_PATH"],
            "access_token": os.environ["DATABRICKS_TOKEN"],
            "use_cloud_fetch": False,
        }

    def fetch_raw(self, table_name: str) -> pd.DataFrame:
        """Read all rows from one configured SAZ source table."""
        if not table_name:
            raise ValueError("table_name must not be blank")

        with self.connection_factory(**self._load_credentials()) as connection:
            with connection.cursor() as cursor:
                cursor.execute(f"SELECT * FROM {table_name}")
                rows = cursor.fetchall()
                columns = [column[0] for column in cursor.description]

        return pd.DataFrame(rows, columns=columns)

    def validate(
        self,
        dataframe: pd.DataFrame,
        transform: Transform,
    ) -> tuple[list[RecordModel], list[dict[str, Any]]]:
        """Transform raw rows; invalid records are excluded and reported, not fatal."""
        records: list[RecordModel] = []
        rejected: list[dict[str, Any]] = []
        for row_number, row in enumerate(dataframe.to_dict(orient="records"), start=1):
            try:
                records.append(self.model_class.model_validate(transform(row)))
            except ValidationError as exc:
                rejected.append({
                    "row_number": row_number,
                    "errors": exc.errors(),
                    "source_row": row,
                })

        return records, rejected