"""Load and validate SAZ pillar input records (one row per pillar per vendor per period)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pandas as pd

from ..common.base_loader import BaseDatabricksLoader
from ..common.constants import (
    MAIN_CATEGORY_TO_OPERATIONAL_COLUMN,
    MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN,
    MAIN_CATEGORY_TO_TABLE,
    SUSTAINABILITY_COLUMN,
    VALUE_CREATION_COLUMNS,
)
from ..common.source_utils import id_component as _id_component
from ..common.source_utils import numeric_source_value as _numeric_source_value
from ..common.source_utils import reporting_period as _reporting_period
from ..common.source_utils import required_source_text as _required_source_text
from ..common.source_utils import source_value as _source_value
from ..common.source_utils import supplier_key as _supplier_key
from .models import PillarInputRecord


def transform_pillar_rows(
	row: Mapping[str, Any],
	main_category: str,
) -> list[Mapping[str, Any]]:
	"""Extract populated pillar-level scores from one raw SAZ source row."""
	parent_company = _required_source_text(row, "parent_company")
	parent_supplier_id = _supplier_key(parent_company)
	period = _reporting_period(row)
	source_reference = _required_source_text(row, "source_file")
	# Subcategory distinguishes multiple product lines the same vendor is measured under
	# in the same month (e.g. WESTROCK: FOLDING CARTONS vs CORRUGATED BOARD), so those
	# pillar measurements aren't mistaken for duplicates of each other and dropped.
	subcategory = _id_component(_source_value(row, "subcategory"))

	pillar_values: list[tuple[str, float | None]] = [
		("SUSTAINABILITY", _numeric_source_value(_source_value(row, SUSTAINABILITY_COLUMN))),
	]

	operational_column = MAIN_CATEGORY_TO_OPERATIONAL_COLUMN[main_category]
	if operational_column is not None:
		pillar_values.append(("OPERATIONAL", _numeric_source_value(_source_value(row, operational_column))))

	value_creation_score: float | None = None
	for column in VALUE_CREATION_COLUMNS:
		value_creation_score = _numeric_source_value(_source_value(row, column))
		if value_creation_score is not None:
			break
	pillar_values.append(("VALUE_CREATION", value_creation_score))

	service_level_column = MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN[main_category]
	if service_level_column is not None:
		pillar_values.append(("SERVICE_LEVEL", _numeric_source_value(_source_value(row, service_level_column))))

	records: list[Mapping[str, Any]] = []
	for pillar_id, source_pillar_score_pct in pillar_values:
		if source_pillar_score_pct is None:
			continue

		records.append({
			"pillar_input_id": f"{main_category}-{parent_supplier_id}-{pillar_id}-{subcategory}-{period:%Y%m}",
			"parent_supplier_id": parent_supplier_id,
			"pillar_id": pillar_id,
			"reporting_period": period,
			"source_pillar_score_pct": source_pillar_score_pct,
			"source_reference": source_reference,
		})

	return records


def load_pillar_input(
	loader: BaseDatabricksLoader[PillarInputRecord] | None = None,
) -> tuple[list[PillarInputRecord], list[dict[str, Any]]]:
	"""Fetch every SAZ category table and return (valid, rejected) pillar input records."""
	active_loader = loader or BaseDatabricksLoader(PillarInputRecord)
	records: list[PillarInputRecord] = []
	rejected: list[dict[str, Any]] = []

	for main_category, table_name in MAIN_CATEGORY_TO_TABLE.items():
		raw = active_loader.fetch_raw(table_name)
		transformed_rows = [
			transformed
			for row in raw.to_dict(orient="records")
			for transformed in transform_pillar_rows(row, main_category)
		]
		valid, invalid = active_loader.validate(pd.DataFrame(transformed_rows), lambda row: row)
		records.extend(valid)
		rejected.extend(invalid)

	# Duplicate grain: pillar_input_id already encodes vendor, pillar, subcategory, and
	# period, so an exact repeat here is a genuine source duplicate. Keep the first
	# occurrence, reject and report the rest.
	seen_ids: set[str] = set()
	deduplicated_records: list[PillarInputRecord] = []
	for record in records:
		if record.pillar_input_id in seen_ids:
			rejected.append({
				"row_number": None,
				"errors": [{"type": "duplicate_key", "msg": "Duplicate pillar_input_id"}],
				"source_row": record.model_dump(),
			})
			continue
		seen_ids.add(record.pillar_input_id)
		deduplicated_records.append(record)

	return deduplicated_records, rejected
