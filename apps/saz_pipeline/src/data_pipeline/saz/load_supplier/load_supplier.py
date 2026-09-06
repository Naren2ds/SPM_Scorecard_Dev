"""Load and validate SAZ supplier master records from all category source tables."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..common.base_loader import BaseDatabricksLoader
from ..common.constants import MAIN_CATEGORY_TO_TABLE
from ..common.source_utils import required_source_text as _required_source_text
from ..common.source_utils import source_value as _source_value
from ..common.source_utils import supplier_key as _supplier_key
from .models import SupplierRecord


def transform_supplier_row(
	row: Mapping[str, Any],
	main_category: str,
) -> Mapping[str, Any]:
	"""Map a raw SAZ source row into the generic SUPPLIER input contract."""
	parent_company = _required_source_text(row, "parent_company")
	supplier_id = _supplier_key(parent_company)

	return {
		"supplier_id": supplier_id,
		"parent_supplier_id": supplier_id,
		"parent_supplier_name": parent_company,
		"vendor_name": "NA",
		"zone": "SAZ",
		"scorecard_category": main_category,
		"gpo_category": main_category,
		"purchasing_category": _source_value(row, "category"),
		"sub_category": _source_value(row, "subcategory"),
	}


def load_supplier(
	loader: BaseDatabricksLoader[SupplierRecord] | None = None,
) -> tuple[list[SupplierRecord], list[dict[str, Any]]]:
    """Fetch every SAZ category table and return (valid, rejected) supplier records."""
    active_loader = loader or BaseDatabricksLoader(SupplierRecord)
    records: list[SupplierRecord] = []
    rejected: list[dict[str, Any]] = []

    for main_category, table_name in MAIN_CATEGORY_TO_TABLE.items():
        raw = active_loader.fetch_raw(table_name)
        valid, invalid = active_loader.validate(
            raw,
            lambda row, category=main_category: transform_supplier_row(row, category),
        )
        records.extend(valid)
        rejected.extend(invalid)

    # supplier_id is the parent company name, so it must be unique: same vendor can
    # appear on multiple source rows (e.g. one per subcategory); keep the first and report the rest.
    seen_supplier_ids: set[str] = set()
    deduplicated_records: list[SupplierRecord] = []
    for record in records:
        if record.supplier_id in seen_supplier_ids:
            rejected.append({
                "row_number": None,
                "errors": [{"type": "duplicate_supplier_key", "msg": "Duplicate supplier_id (parent company name)"}],
                "source_row": record.model_dump(),
            })
            continue
        seen_supplier_ids.add(record.supplier_id)
        deduplicated_records.append(record)

    return deduplicated_records, rejected
