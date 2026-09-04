"""Load and validate long-format SAZ KPI input records from wide source tables."""

from __future__ import annotations

import calendar
import math
from collections.abc import Mapping
from datetime import date
from typing import Any

import pandas as pd

from ..common.base_loader import BaseDatabricksLoader
from ..common.constants import ApplicabilityStatus, MAIN_CATEGORY_TO_KPI_COLUMNS, MAIN_CATEGORY_TO_TABLE
from ..load_supplier.load_supplier import _source_value, _supplier_key
from .models import KpiInputRecord


_EMPTY_SOURCE_VALUES = {"", "NA", "N/A", "NULL", "NONE", "NAN", "(BLANK)"}


def _required_source_text(row: Mapping[str, Any], column_name: str) -> str:
	value = _source_value(row, column_name)
	if value is None or not str(value).strip():
		raise ValueError(f"Missing required source column value: {column_name}")
	return str(value).strip()


def _reporting_period(row: Mapping[str, Any]) -> date:
	year_text = _required_source_text(row, "year")
	month_text = _required_source_text(row, "month")
	try:
		year = int(float(year_text))
		month = int(month_text) if month_text.isdigit() else list(calendar.month_name).index(month_text.title())
		return date(year, month, 1)
	except (ValueError, IndexError) as exc:
		raise ValueError(f"Invalid reporting period: year={year_text!r}, month={month_text!r}") from exc


def _numeric_source_value(value: Any) -> float | None:
	if value is None or (isinstance(value, float) and math.isnan(value)):
		return None
	if isinstance(value, str) and value.strip().upper() in _EMPTY_SOURCE_VALUES:
		return None
	try:
		return float(value)
	except (TypeError, ValueError) as exc:
		raise ValueError(f"KPI source value must be numeric or empty, got {value!r}") from exc


def _id_component(value: Any) -> str:
	"""Normalize a value for safe inclusion in kpi_input_id; 'NA' when absent."""
	if value is None or not str(value).strip():
		return "NA"
	return str(value).strip()


def transform_kpi_rows(
	row: Mapping[str, Any],
	main_category: str,
) -> list[Mapping[str, Any]]:
	"""Unpivot populated configured KPI columns from one raw SAZ source row."""
	parent_company = _required_source_text(row, "parent_company")
	supplier_id = _supplier_key(parent_company)
	reporting_period = _reporting_period(row)
	source_reference = _required_source_text(row, "source_file")
	# Subcategory distinguishes multiple product lines the same vendor is measured under
	# in the same month (e.g. WESTROCK: FOLDING CARTONS vs CORRUGATED BOARD) so those
	# measurements aren't mistaken for duplicates of each other and dropped.
	subcategory = _id_component(_source_value(row, "subcategory"))
	period_end_date = date(
		reporting_period.year,
		reporting_period.month,
		calendar.monthrange(reporting_period.year, reporting_period.month)[1],
	)

	records: list[Mapping[str, Any]] = []
	for kpi_id in MAIN_CATEGORY_TO_KPI_COLUMNS[main_category]:
		input_value = _numeric_source_value(_source_value(row, kpi_id))
		if input_value is None:
			continue

		records.append({
			"kpi_input_id": f"{main_category}-{supplier_id}-{kpi_id}-{subcategory}-{reporting_period:%Y%m}",
			"supplier_id": supplier_id,
			"kpi_id": kpi_id,
			"reporting_period": reporting_period,
			"period_start_date": reporting_period,
			"period_end_date": period_end_date,
			"input_value": input_value,
			"applicability_status": ApplicabilityStatus.APPLICABLE,
			"source_reference": source_reference,
		})

	return records


def load_kpi_input(
	loader: BaseDatabricksLoader[KpiInputRecord] | None = None,
) -> tuple[list[KpiInputRecord], list[dict[str, Any]]]:
	"""Fetch every SAZ category table and return (valid, rejected) KPI input records."""
	active_loader = loader or BaseDatabricksLoader(KpiInputRecord)
	records: list[KpiInputRecord] = []
	rejected: list[dict[str, Any]] = []

	for main_category, table_name in MAIN_CATEGORY_TO_TABLE.items():
		raw = active_loader.fetch_raw(table_name)
		transformed_rows = [
			transformed
			for row in raw.to_dict(orient="records")
			for transformed in transform_kpi_rows(row, main_category)
		]
		valid, invalid = active_loader.validate(pd.DataFrame(transformed_rows), lambda row: row)
		records.extend(valid)
		rejected.extend(invalid)

	# Duplicate grain: kpi_input_id already encodes supplier, KPI, subcategory, and
	# period, so an exact repeat here is a genuine source duplicate, not a distinct
	# product-line measurement. Keep the first occurrence, reject and report the rest.
	seen_ids: set[str] = set()
	deduplicated_records: list[KpiInputRecord] = []
	for record in records:
		if record.kpi_input_id in seen_ids:
			rejected.append({
				"row_number": None,
				"errors": [{"type": "duplicate_key", "msg": "Duplicate kpi_input_id"}],
				"source_row": record.model_dump(),
			})
			continue
		seen_ids.add(record.kpi_input_id)
		deduplicated_records.append(record)

	return deduplicated_records, rejected
