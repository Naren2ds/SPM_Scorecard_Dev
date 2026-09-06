"""
Promotion job: copies validated SOURCE_PROVIDED input records into the shared
result tables at source grain -- PILLAR_INPUT -> PILLAR_SCORE and
SCORECARD_INPUT -> SCORECARD_SCORE. No aggregation and no KPI_SCORE promotion;
SAZ supplies raw KPI measurements, not per-KPI scores.

Written against the generic input/result models so it can be reused by any
future SOURCE_PROVIDED scorecard, not just SAZ.
"""

from __future__ import annotations

from ..common.constants import CalculationSource
from ..load_pillar_input.models import PillarInputRecord
from ..load_scorecard_input.models import ScorecardInputRecord
from .models import PillarScoreRecord, ScorecardScoreRecord


def promote_pillar_scores(pillar_inputs: list[PillarInputRecord]) -> list[PillarScoreRecord]:
    """1:1 copy of PILLAR_INPUT into PILLAR_SCORE; engine-only columns stay NULL."""
    return [
        PillarScoreRecord(
            supplier_id=record.supplier_id,
            parent_supplier_id=record.parent_supplier_id,
            pillar_id=record.pillar_id,
            zone=record.zone,
            country=record.country,
            gpo_category=record.gpo_category,
            purchasing_category=record.purchasing_category,
            scorecard_category=record.scorecard_category,
            sub_category=record.sub_category,
            reporting_period=record.reporting_period,
            pillar_score_pct=record.source_pillar_score_pct,
            weighted_contribution=record.source_weighted_contribution,
            coverage_pct=record.source_coverage_pct,
            calculation_source=CalculationSource.SOURCE_PROVIDED,
        )
        for record in pillar_inputs
    ]


def promote_scorecard_scores(scorecard_inputs: list[ScorecardInputRecord]) -> list[ScorecardScoreRecord]:
    """1:1 copy of SCORECARD_INPUT into SCORECARD_SCORE; engine-only columns stay NULL."""
    return [
        ScorecardScoreRecord(
            supplier_id=record.supplier_id,
            parent_supplier_id=record.parent_supplier_id,
            scorecard_id=record.scorecard_id,
            zone=record.zone,
            country=record.country,
            gpo_category=record.gpo_category,
            purchasing_category=record.purchasing_category,
            scorecard_category=record.scorecard_category,
            sub_category=record.sub_category,
            reporting_period=record.reporting_period,
            normalized_score=record.source_normalized_score,
            overall_coverage_pct=record.source_coverage_pct,
            coverage_adjusted_score=record.source_coverage_adjusted_score,
            score_band=record.source_score_band,
            calculation_source=CalculationSource.SOURCE_PROVIDED,
        )
        for record in scorecard_inputs
    ]
