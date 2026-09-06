"""
Pydantic models for the shared PILLAR_SCORE and SCORECARD_SCORE result tables.

These mirror the ERD in Table_Schema.MD. For a SOURCE_PROVIDED scorecard, the
engine-only columns (earned_points, applicable_max_points, available_kpi_weight,
expected_kpi_weight, applicable_pillar_weight) are always NULL -- they describe
KPI-level roll-up math that SAZ never performs.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from ..common.constants import CalculationSource


class PillarScoreRecord(BaseModel):
    supplier_id: str = Field(..., min_length=1)
    parent_supplier_id: str = Field(..., min_length=1)
    pillar_id: str = Field(..., min_length=1)
    zone: str = Field(..., min_length=1)
    country: str | None = Field(default=None)
    gpo_category: str | None = Field(default=None)
    purchasing_category: str | None = Field(default=None)
    scorecard_category: str | None = Field(default=None)
    sub_category: str | None = Field(default=None)
    reporting_period: date
    earned_points: float | None = Field(default=None, description="Engine-only; requires KPI-level scores")
    applicable_max_points: float | None = Field(default=None, description="Engine-only")
    pillar_score_pct: float = Field(..., description="Copied unchanged from source_pillar_score_pct")
    weighted_contribution: float | None = Field(default=None, description="NULL when the source doesn't supply it")
    available_kpi_weight: float | None = Field(default=None, description="Engine-only")
    expected_kpi_weight: float | None = Field(default=None, description="Engine-only")
    coverage_pct: float | None = Field(default=None, description="NULL when the source doesn't supply it")
    calculation_source: CalculationSource = Field(default=CalculationSource.SOURCE_PROVIDED)


class ScorecardScoreRecord(BaseModel):
    supplier_id: str = Field(..., min_length=1)
    parent_supplier_id: str = Field(..., min_length=1)
    scorecard_id: str = Field(..., min_length=1)
    zone: str = Field(..., min_length=1)
    country: str | None = Field(default=None)
    gpo_category: str | None = Field(default=None)
    purchasing_category: str | None = Field(default=None)
    scorecard_category: str | None = Field(default=None)
    sub_category: str | None = Field(default=None)
    reporting_period: date
    normalized_score: float = Field(..., description="Copied unchanged from source_normalized_score")
    applicable_pillar_weight: float | None = Field(default=None, description="Engine-only")
    overall_coverage_pct: float | None = Field(default=None, description="NULL when the source doesn't supply it")
    coverage_adjusted_score: float | None = Field(default=None)
    score_band: str | None = Field(default=None, description="NULL when the source doesn't supply it")
    calculation_source: CalculationSource = Field(default=CalculationSource.SOURCE_PROVIDED)
