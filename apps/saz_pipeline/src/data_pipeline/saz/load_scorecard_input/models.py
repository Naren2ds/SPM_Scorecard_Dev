"""
Pydantic model for the SCORECARD_INPUT table, populated from the SAZ source.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field, model_validator

from ..common.constants import SCORECARD_ID


class ScorecardInputRecord(BaseModel):
    scorecard_input_id: str = Field(..., min_length=1)
    supplier_id: str = Field(..., min_length=1, description="Grain this score is measured at; equals parent_supplier_id when the source has no vendor-level detail")
    parent_supplier_id: str = Field(..., min_length=1)
    scorecard_id: str = Field(default=SCORECARD_ID)
    zone: str = Field(..., min_length=1)
    country: str | None = Field(default=None, description="NULL when the zone source has no country breakdown")
    gpo_category: str | None = Field(default=None, description="NULL when the zone source has no GPO category")
    purchasing_category: str | None = Field(default=None, description="NULL when the zone source has no purchasing category")
    scorecard_category: str | None = Field(default=None)
    sub_category: str | None = Field(default=None, description="Product-line dimension; NULL when unavailable in a zone source")
    reporting_period: date
    source_normalized_score: float = Field(..., description="Raw overall score on its native source scale (e.g. SAZ uses 0-1000)")
    source_coverage_pct: float | None = Field(default=None, ge=0, le=1)
    source_coverage_adjusted_score: float | None = Field(default=None, description="Defaults to source_normalized_score when the source doesn't provide one")
    source_score_band: str | None = Field(default=None)
    source_reference: str = Field(..., min_length=1)

    @model_validator(mode="after")
    def default_coverage_adjusted_score(self) -> "ScorecardInputRecord":
        # No coverage-adjusted score is provided at the source; treat full coverage
        # as the default rather than leaving the field blank.
        if self.source_coverage_adjusted_score is None:
            self.source_coverage_adjusted_score = self.source_normalized_score
        return self
