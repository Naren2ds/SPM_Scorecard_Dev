"""
Pydantic model for the SUPPLIER_SPEND table, populated from the SAZ source.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class SupplierSpendRecord(BaseModel):
    spend_id: str = Field(..., min_length=1)
    supplier_id: str = Field(..., min_length=1)
    parent_supplier_id: str = Field(..., min_length=1, description="Roll-up key; equals supplier_id when the source has no vendor-level detail")
    zone: str = Field(..., min_length=1)
    country: str | None = Field(default=None, description="NULL when the zone source has no country breakdown")
    gpo_category: str | None = Field(default=None)
    purchasing_category: str | None = Field(default=None)
    scorecard_category: str | None = Field(default=None)
    sub_category: str | None = Field(default=None)
    reporting_period: date
    spend_amount: float | None = Field(default=None, description="Source currency amount; NULL when the source value is absent or non-numeric")
    source_reference: str = Field(..., min_length=1)
