"""Shared source-row parsing helpers used across all SAZ loaders."""

from __future__ import annotations

import calendar
import math
import re
from collections.abc import Mapping
from datetime import date
from typing import Any

_EMPTY_SOURCE_VALUES = {"", "NA", "N/A", "NULL", "NONE", "NAN", "(BLANK)"}


def source_value(row: Mapping[str, Any], column_name: str) -> Any:
	"""Return a source value using case-insensitive column matching."""
	for source_column, value in row.items():
		if source_column.lower() == column_name.lower():
			return value
	return None


def required_source_text(row: Mapping[str, Any], column_name: str) -> str:
	value = source_value(row, column_name)
	if value is None or not str(value).strip():
		raise ValueError(f"Missing required source column value: {column_name}")
	return str(value).strip()


def supplier_key(parent_company: str) -> str:
	# No granular supplier ID exists in the SAZ feed; the parent company name IS the key.
	return re.sub(r"\s+", " ", parent_company.strip())


def reporting_period(row: Mapping[str, Any]) -> date:
	year_text = required_source_text(row, "year")
	month_text = required_source_text(row, "month")
	try:
		year = int(float(year_text))
		month = int(month_text) if month_text.isdigit() else list(calendar.month_name).index(month_text.title())
		return date(year, month, 1)
	except (ValueError, IndexError) as exc:
		raise ValueError(f"Invalid reporting period: year={year_text!r}, month={month_text!r}") from exc


def numeric_source_value(value: Any) -> float | None:
	if value is None or (isinstance(value, float) and math.isnan(value)):
		return None
	if isinstance(value, str) and value.strip().upper() in _EMPTY_SOURCE_VALUES:
		return None
	try:
		return float(value)
	except (TypeError, ValueError) as exc:
		raise ValueError(f"Source value must be numeric or empty, got {value!r}") from exc


def id_component(value: Any) -> str:
	"""Normalize a value for safe inclusion in a composite ID; 'NA' when absent."""
	if value is None or not str(value).strip():
		return "NA"
	return str(value).strip()
