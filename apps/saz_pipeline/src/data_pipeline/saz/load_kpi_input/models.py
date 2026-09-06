"""
Pydantic model for the KPI_INPUT table (SOURCE_PROVIDED branch), populated from the SAZ source.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field, field_validator

from ..common.constants import ApplicabilityStatus


class KpiInputRecord(BaseModel):
    kpi_input_id: str = Field(..., min_length=1)
    supplier_id: str = Field(..., min_length=1)
    parent_supplier_id: str = Field(..., min_length=1, description="Roll-up key; equals supplier_id when the source has no vendor-level detail")
    kpi_id: str = Field(..., min_length=1, description="Source column name, e.g. 'otif', 'acceptance_term'")
    kpi_version_id: str = Field(..., min_length=1, description="FK to KPI_VERSION; pins the scoring rules in force for this period")
    zone: str = Field(..., min_length=1)
    country: str | None = Field(default=None, description="NULL when the zone source has no country breakdown")
    gpo_category: str | None = Field(default=None, description="NULL when the zone source has no GPO category")
    purchasing_category: str | None = Field(default=None, description="NULL when the zone source has no purchasing category")
    scorecard_category: str | None = Field(default=None)
    sub_category: str | None = Field(default=None, description="Product-line dimension; NULL when unavailable in a zone source")
    reporting_period: date = Field(..., description="First day of the reporting month")
    period_type: str = Field(default="MONTHLY")
    period_start_date: date
    period_end_date: date
    input_value: float = Field(..., description="Raw KPI measurement as received from source (SAZ does not pre-score individual KPIs)")
    source_kpi_score: float | None = Field(default=None, description="Reserved for sources that provide a pre-computed per-KPI score; unused by SAZ")
    applicability_status: ApplicabilityStatus
    source_reference: str = Field(..., min_length=1, description="e.g. source_file value")

    @field_validator("period_end_date")
    @classmethod
    def end_not_before_start(cls, value: date, info) -> date:
        start = info.data.get("period_start_date")
        if start is not None and value < start:
            raise ValueError("period_end_date must not be before period_start_date")
        return value
