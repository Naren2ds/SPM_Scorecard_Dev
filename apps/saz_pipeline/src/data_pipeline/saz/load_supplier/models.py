"""
Pydantic model for the SUPPLIER table, populated from the SAZ source.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class SupplierRecord(BaseModel):
    supplier_id: str = Field(..., min_length=1)
    parent_supplier_id: str = Field(..., min_length=1)
    parent_supplier_name: str = Field(..., min_length=1)
    vendor_name: str = Field(..., min_length=1, description="'NA' when only parent-level identity is available")
    zone: str = Field(default="SAZ")
    scorecard_category: str = Field(..., min_length=1, description="Source main_category")
    saz_category: str | None = Field(default=None, description="Source category (sub-grouping within main_category)")
    sub_category: str | None = Field(default=None, description="Source subcategory")

    @field_validator("parent_supplier_name", "vendor_name", "scorecard_category")
    @classmethod
    def not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped

    @field_validator("saz_category", "sub_category", mode="before")
    @classmethod
    def blank_to_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = str(value).strip()
        return stripped or None
