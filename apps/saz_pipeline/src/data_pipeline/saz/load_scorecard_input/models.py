"""
Pydantic model for the SCORECARD_INPUT table, populated from the SAZ source.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from ..common.constants import SCORECARD_ID


class ScorecardInputRecord(BaseModel):
    scorecard_input_id: str = Field(..., min_length=1)
    parent_supplier_id: str = Field(..., min_length=1)
    scorecard_id: str = Field(default=SCORECARD_ID)
    reporting_period: date
    source_normalized_score: float = Field(..., ge=0)
    source_coverage_pct: float | None = Field(default=None, ge=0, le=1)
    source_coverage_adjusted_score: float | None = Field(default=None, ge=0)
    source_score_band: str | None = Field(default=None)
    source_reference: str = Field(..., min_length=1)
