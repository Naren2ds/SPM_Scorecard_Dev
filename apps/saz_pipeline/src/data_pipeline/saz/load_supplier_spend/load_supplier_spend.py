"""Load and validate SAZ supplier spend records (one row per supplier per sub-category per period)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pandas as pd

from ..common.base_loader import BaseDatabricksLoader
from ..common.constants import MAIN_CATEGORY_TO_TABLE
from ..common.source_utils import id_component as _id_component
from ..common.source_utils import numeric_source_value as _numeric_source_value
from ..common.source_utils import reporting_period as _reporting_period
from ..common.source_utils import required_source_text as _required_source_text
from ..common.source_utils import source_value as _source_value
from ..common.source_utils import supplier_key as _supplier_key
from .models import SupplierSpendRecord


def transform_spend_row(
	row: Mapping[str, Any],
	main_category: str,
) -> Mapping[str, Any]:
	"""Map one raw SAZ source row into the SUPPLIER_SPEND contract."""
	parent_company = _required_source_text(row, "parent_company")
	supplier_id = _supplier_key(parent_company)
	period = _reporting_period(row)
	source_reference = _required_source_text(row, "source_file")
	subcategory = _id_component(_source_value(row, "subcategory"))

	return {
		"spend_id": f"{main_category}-{supplier_id}-{subcategory}-{period:%Y%m}",
		"supplier_id": supplier_id,
		"parent_supplier_id": supplier_id,
		"zone": "SAZ",
		"country": None,
		"gpo_category": main_category,
		"purchasing_category": _source_value(row, "category"),
		"scorecard_category": main_category,
		"sub_category": None if subcategory == "NA" else subcategory,
		"reporting_period": period,
		"spend_amount": _numeric_source_value(_source_value(row, "total_spend")),
		"source_reference": source_reference,
	}


def load_supplier_spend(
	loader: BaseDatabricksLoader[SupplierSpendRecord] | None = None,
) -> tuple[list[SupplierSpendRecord], list[dict[str, Any]]]:
	"""Fetch every SAZ category table and return (valid, rejected) spend records."""
	active_loader = loader or BaseDatabricksLoader(SupplierSpendRecord)
	records: list[SupplierSpendRecord] = []
	rejected: list[dict[str, Any]] = []

	for main_category, table_name in MAIN_CATEGORY_TO_TABLE.items():
		raw = active_loader.fetch_raw(table_name)
		transformed_rows = [
			transform_spend_row(row, main_category)
			for row in raw.to_dict(orient="records")
		]
		valid, invalid = active_loader.validate(pd.DataFrame(transformed_rows), lambda row: row)
		records.extend(valid)
		rejected.extend(invalid)

	# spend_id already encodes supplier, sub-category, and period, so an exact repeat
	# here is a genuine source duplicate. Keep the first, reject and report the rest.
	seen_ids: set[str] = set()
	deduplicated_records: list[SupplierSpendRecord] = []
	for record in records:
		if record.spend_id in seen_ids:
			rejected.append({
				"row_number": None,
				"errors": [{"type": "duplicate_key", "msg": "Duplicate spend_id"}],
				"source_row": record.model_dump(),
			})
			continue
		seen_ids.add(record.spend_id)
		deduplicated_records.append(record)

	return deduplicated_records, rejected
