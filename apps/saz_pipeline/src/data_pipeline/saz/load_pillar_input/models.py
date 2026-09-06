"""
Pydantic model for the PILLAR_INPUT table, populated from the SAZ source.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from ..common.constants import SCORECARD_ID


class PillarInputRecord(BaseModel):
    pillar_input_id: str = Field(..., min_length=1)
    supplier_id: str = Field(..., min_length=1, description="Grain this score is measured at; equals parent_supplier_id when the source has no vendor-level detail")
    parent_supplier_id: str = Field(..., min_length=1)
    scorecard_id: str = Field(default=SCORECARD_ID)
    pillar_id: str = Field(..., min_length=1)
    zone: str = Field(..., min_length=1)
    country: str | None = Field(default=None, description="NULL when the zone source has no country breakdown")
    gpo_category: str | None = Field(default=None, description="NULL when the zone source has no GPO category")
    purchasing_category: str | None = Field(default=None, description="NULL when the zone source has no purchasing category")
    scorecard_category: str | None = Field(default=None)
    sub_category: str | None = Field(default=None, description="Product-line dimension; NULL when unavailable in a zone source")
    reporting_period: date
    source_pillar_score_pct: float = Field(..., description="Raw pillar score on its native source scale (e.g. SAZ uses 0-1000)")
    source_weighted_contribution: float | None = Field(default=None)
    source_coverage_pct: float | None = Field(default=None, ge=0, le=1)
    source_reference: str = Field(..., min_length=1)
