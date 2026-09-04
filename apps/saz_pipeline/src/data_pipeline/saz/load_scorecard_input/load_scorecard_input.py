"""Load and validate SAZ scorecard input records (one row per vendor per period)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pandas as pd

from ..common.base_loader import BaseDatabricksLoader
from ..common.constants import MAIN_CATEGORY_TO_SCORECARD_COLUMN, MAIN_CATEGORY_TO_TABLE
from ..common.source_utils import id_component as _id_component
from ..common.source_utils import numeric_source_value as _numeric_source_value
from ..common.source_utils import reporting_period as _reporting_period
from ..common.source_utils import required_source_text as _required_source_text
from ..common.source_utils import source_value as _source_value
from ..common.source_utils import supplier_key as _supplier_key
from .models import ScorecardInputRecord


def transform_scorecard_row(
	row: Mapping[str, Any],
	main_category: str,
) -> Mapping[str, Any] | None:
	"""Extract the overall SAZ-provided score from one raw source row, if populated."""
	score_column = MAIN_CATEGORY_TO_SCORECARD_COLUMN[main_category]
	source_normalized_score = _numeric_source_value(_source_value(row, score_column))
	if source_normalized_score is None:
		return None

	parent_company = _required_source_text(row, "parent_company")
	parent_supplier_id = _supplier_key(parent_company)
	period = _reporting_period(row)
	source_reference = _required_source_text(row, "source_file")
	# Subcategory distinguishes multiple product lines the same vendor is measured under
	# in the same month (e.g. WESTROCK: FOLDING CARTONS vs CORRUGATED BOARD), so those
	# scorecard measurements aren't mistaken for duplicates of each other and dropped.
	subcategory = _id_component(_source_value(row, "subcategory"))

	return {
		"scorecard_input_id": f"{main_category}-{parent_supplier_id}-{subcategory}-{period:%Y%m}",
		"parent_supplier_id": parent_supplier_id,
		"reporting_period": period,
		"source_normalized_score": source_normalized_score,
		"source_reference": source_reference,
	}


def load_scorecard_input(
	loader: BaseDatabricksLoader[ScorecardInputRecord] | None = None,
) -> tuple[list[ScorecardInputRecord], list[dict[str, Any]]]:
	"""Fetch every SAZ category table and return (valid, rejected) scorecard input records."""
	active_loader = loader or BaseDatabricksLoader(ScorecardInputRecord)
	records: list[ScorecardInputRecord] = []
	rejected: list[dict[str, Any]] = []

	for main_category, table_name in MAIN_CATEGORY_TO_TABLE.items():
		raw = active_loader.fetch_raw(table_name)
		transformed_rows = [
			transformed
			for row in raw.to_dict(orient="records")
			if (transformed := transform_scorecard_row(row, main_category)) is not None
		]
		valid, invalid = active_loader.validate(pd.DataFrame(transformed_rows), lambda row: row)
		records.extend(valid)
		rejected.extend(invalid)

	# Duplicate grain: scorecard_input_id already encodes vendor, subcategory, and
	# period, so an exact repeat here is a genuine source duplicate. Keep the first
	# occurrence, reject and report the rest.
	seen_ids: set[str] = set()
	deduplicated_records: list[ScorecardInputRecord] = []
	for record in records:
		if record.scorecard_input_id in seen_ids:
			rejected.append({
				"row_number": None,
				"errors": [{"type": "duplicate_key", "msg": "Duplicate scorecard_input_id"}],
				"source_row": record.model_dump(),
			})
			continue
		seen_ids.add(record.scorecard_input_id)
		deduplicated_records.append(record)

	return deduplicated_records, rejected
