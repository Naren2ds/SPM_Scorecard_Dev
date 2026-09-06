"""Load and validate long-format SAZ KPI input records from wide source tables."""

from __future__ import annotations

import calendar
from collections.abc import Mapping
from datetime import date
from typing import Any

import pandas as pd

from ..common.base_loader import BaseDatabricksLoader
from ..common.constants import ApplicabilityStatus, MAIN_CATEGORY_TO_KPI_COLUMNS, MAIN_CATEGORY_TO_TABLE
from ..common.configuration import KPI_VERSION_ID_BY_KPI_ID
from ..common.source_utils import id_component as _id_component
from ..common.source_utils import numeric_source_value as _numeric_source_value
from ..common.source_utils import reporting_period as _reporting_period
from ..common.source_utils import required_source_text as _required_source_text
from ..common.source_utils import source_value as _source_value
from ..common.source_utils import supplier_key as _supplier_key
from .models import KpiInputRecord


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
			"parent_supplier_id": supplier_id,
			"kpi_id": kpi_id,
			"kpi_version_id": KPI_VERSION_ID_BY_KPI_ID[kpi_id],
			"zone": "SAZ",
			"country": None,
			"scorecard_category": main_category,
			"gpo_category": main_category,
			"purchasing_category": _source_value(row, "category"),
			"sub_category": None if subcategory == "NA" else subcategory,
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
