"""
Configuration data for the SAZ scorecard (SCORECARD_DEFINITION, PILLAR_DEFINITION,
PILLAR_APPLICABILITY_RULE, and a minimal KPI catalogue). Physical Delta tables for
these are built by the MLE; this module is the Python source of truth used to
validate referential integrity before the promotion job runs.
"""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path

from pydantic import BaseModel, Field

from .constants import (
    MAIN_CATEGORY_TO_KPI_COLUMNS,
    MAIN_CATEGORY_TO_OPERATIONAL_COLUMN,
    MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN,
    SCORECARD_ID,
)


class ScorecardDefinition(BaseModel):
    scorecard_id: str = Field(..., min_length=1)
    scorecard_name: str = Field(..., min_length=1)
    calculation_mode: str = Field(..., min_length=1)
    calculation_frequency: str = Field(..., min_length=1)
    scorecard_status: str = Field(..., min_length=1)
    effective_from: date
    effective_to: date | None = Field(default=None)


class PillarDefinition(BaseModel):
    pillar_id: str = Field(..., min_length=1)
    scorecard_id: str = Field(..., min_length=1)
    pillar_name: str = Field(..., min_length=1)
    pillar_weight: float = Field(..., description="PENDING business confirmation; equal-split placeholder for now")
    is_active: bool = Field(default=True)


class KpiDefinition(BaseModel):
    kpi_id: str = Field(..., min_length=1)
    kpi_name: str | None = Field(default=None, description="PENDING business confirmation; proposed from column name")
    input_unit: str | None = Field(default=None, description="PENDING business confirmation; proposed from observed value range")
    pillar_id: str | None = Field(default=None, description="PENDING business confirmation; not assigned yet")
    is_active: bool = Field(default=True)


class KpiVersion(BaseModel):
    kpi_version_id: str = Field(..., min_length=1)
    kpi_id: str = Field(..., min_length=1)
    max_score: float | None = Field(default=None, description="ENGINE_CALCULATED only; unused by SAZ (SOURCE_PROVIDED)")
    scoring_method: str | None = Field(default=None, description="ENGINE_CALCULATED only; unused by SAZ (SOURCE_PROVIDED)")
    direction: str | None = Field(default=None, description="ENGINE_CALCULATED only; unused by SAZ (SOURCE_PROVIDED)")
    floor_value: float | None = Field(default=None, description="ENGINE_CALCULATED only; unused by SAZ (SOURCE_PROVIDED)")
    target_value: float | None = Field(default=None, description="ENGINE_CALCULATED only; unused by SAZ (SOURCE_PROVIDED)")
    period_granularity: str = Field(default="MONTHLY")
    effective_from: date
    effective_to: date | None = Field(default=None)


SCORECARD_DEFINITIONS: list[ScorecardDefinition] = [
    ScorecardDefinition(
        scorecard_id=SCORECARD_ID,
        scorecard_name="SAZ Supplier Performance",
        calculation_mode="SOURCE_PROVIDED",
        calculation_frequency="MONTHLY",
        scorecard_status="ACTIVE",
        effective_from=date(2026, 1, 1),
        effective_to=None,
    ),
]

# pillar_weight is an equal-split placeholder (100 / 4 pillars) pending business
# confirmation. SAZ pillar/overall scores are supplied directly, not computed from
# these weights, so the placeholder does not affect SAZ's promoted score values.
PILLAR_DEFINITIONS: list[PillarDefinition] = [
    PillarDefinition(pillar_id="SUSTAINABILITY", scorecard_id=SCORECARD_ID, pillar_name="Sustainability", pillar_weight=25.0),
    PillarDefinition(pillar_id="OPERATIONAL", scorecard_id=SCORECARD_ID, pillar_name="Operational", pillar_weight=25.0),
    PillarDefinition(pillar_id="VALUE_CREATION", scorecard_id=SCORECARD_ID, pillar_name="Value Creation", pillar_weight=25.0),
    PillarDefinition(pillar_id="SERVICE_LEVEL", scorecard_id=SCORECARD_ID, pillar_name="Service Level", pillar_weight=25.0),
]


class PillarApplicabilityRule(BaseModel):
    pillar_rule_id: str = Field(..., min_length=1)
    pillar_id: str = Field(..., min_length=1)
    attribute_name: str = Field(default="scorecard_category")
    operator: str = Field(default="EQUALS")
    attribute_value: str = Field(..., min_length=1)
    is_applicable: bool
    effective_from: date
    effective_to: date | None = Field(default=None)


def _build_pillar_applicability_rules() -> list[PillarApplicabilityRule]:
    """Derive NOT_APPLICABLE rules directly from the confirmed per-category pillar
    column mapping. A category only gets an exclusion row when its source table
    never populates that pillar's column; absence of a rule means applicable.
    For SAZ (SOURCE_PROVIDED), these rules are validation/display metadata only --
    they are never used to recalculate the SAZ-provided pillar/overall scores."""
    rules: list[PillarApplicabilityRule] = []
    for pillar_id, column_map in (
        ("OPERATIONAL", MAIN_CATEGORY_TO_OPERATIONAL_COLUMN),
        ("SERVICE_LEVEL", MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN),
    ):
        for main_category, column in column_map.items():
            if column is not None:
                continue
            category_slug = main_category.upper().replace(" ", "_")
            rules.append(PillarApplicabilityRule(
                pillar_rule_id=f"SAZ_{pillar_id}_{category_slug}_2026",
                pillar_id=pillar_id,
                attribute_value=main_category,
                is_applicable=False,
                effective_from=date(2026, 1, 1),
            ))
    return rules


PILLAR_APPLICABILITY_RULES: list[PillarApplicabilityRule] = _build_pillar_applicability_rules()

# Minimal KPI catalogue for orphan-checking KPI_INPUT.kpi_id, seeded with the
# proposed kpi_name/input_unit from SAZ_Pipeline.MD's unit/name proposal table.
# All values here are PENDING business confirmation, not final business labels.
# "pending" input_unit means the observed value range didn't fit percent_0_100
# (e.g. absenteeism, sla_vacancies, cac, cpo, op, media_tools, media_system, extra_cost).
_KPI_NAME_AND_UNIT: dict[str, tuple[str, str | None]] = {
    "acceptance_term": ("Acceptance Term", "percent_0_100"),
    "cost": ("Cost Adherence", "percent_0_100"),
    "cash_flow": ("Cash Flow Adherence", "percent_0_100"),
    "engagement": ("Engagement", "percent_0_100"),
    "price": ("Price Adherence", "percent_0_100"),
    "upload_nf": ("Invoice (NF) Upload", "percent_0_100"),
    "turnover": ("Turnover", "percent_0_100"),
    "invoice_compliance_po_not_found": ("Invoice Compliance (PO Not Found)", "percent_0_100"),
    "invoice_compliance": ("Invoice Compliance", "percent_0_100"),
    "absenteeism": ("Absenteeism", None),  # pending
    "satisfaction": ("Satisfaction", "percent_0_100"),
    "gps": ("GPS", "percent_0_100"),
    "bees_tasks": ("BEES Tasks", "percent_0_100"),
    "sla_vacancies": ("SLA Vacancies", None),  # pending
    "blank_route": ("Blank Route", "percent_0_100"),
    "deloitte_compliance": ("Deloitte Compliance", "percent_0_100"),
    "turnover_perception": ("Turnover Perception", "percent_0_100"),
    "contract_compliance_tech": ("Contract Compliance (Tech)", "percent_0_100"),
    "quality_tech": ("Quality (Tech)", "percent_0_100"),
    "ns": ("NS (Service Level Index?)", "index_0_1000"),
    "ontime_production": ("On-Time Production", "percent_0_100"),
    "recall": ("Recall", "percent_0_100"),
    "recall_ontime": ("Recall On-Time", "percent_0_100"),
    "quality_recall_ontime_recall": ("Quality Recall On-Time", "percent_0_100"),
    "docs_nok_media_system": ("Docs NOK (Media System)", "percent_0_100"),
    "events_audit": ("Events Audit", "percent_0_100"),
    "contract_compliance": ("Contract Compliance", "percent_0_100"),
    "nps": ("Net Promoter Score", "index_neg100_100"),
    "media_tools": ("Media Tools", None),  # pending
    "cac": ("Customer Acquisition Cost", None),  # pending
    "cpo": ("Cost Per Order", None),  # pending
    "ratio_prod": ("Production Ratio", "percent_0_100"),
    "extra_cost": ("Extra Cost", None),  # pending
    "op": ("OP", None),  # pending
    "media_system": ("Media System", None),  # pending
    "mtf_total": ("MTF Total", "percent_0_100"),
    "mtf_audit": ("MTF Audit", "percent_0_100"),
    "mtf_leadtime": ("MTF Lead Time", "percent_0_100"),
    "mtf_tickets": ("MTF Tickets", "percent_0_100"),
    "mtf_audit_div": ("MTF Audit (Div)", "percent_0_100"),
    "mtf_on_time": ("MTF On-Time", "percent_0_100"),
    "project_nps": ("Project NPS", "percent_0_100"),
    "ariba_adherence": ("Ariba Adherence", "percent_0_100"),
    "eclipse_adherence": ("Eclipse Adherence", "percent_0_100"),
    "quality_cars": ("Quality (CARs)", "percent_0_100"),
    "quality_documentation": ("Quality Documentation", "percent_0_100"),
    "order_acceptance_rate": ("Order Acceptance Rate", "percent_0_100"),
    "otif": ("On Time In Full", "percent_0_100"),
}


def _load_kpi_pillar_ids() -> dict[str, str]:
    mapping_path = (
        Path(__file__).resolve().parents[4]
        / "Mapping"
        / "SAZ_Category_Pillar_KPI_Mapping_Resolved.csv"
    )
    assignments: dict[str, str] = {}
    with mapping_path.open(encoding="utf-8", newline="") as mapping_file:
        for row in csv.DictReader(mapping_file):
            kpi_id = row["source_kpi_id"].strip()
            pillar_id = row["pillar_id"].strip()
            if not kpi_id:
                continue
            existing_pillar_id = assignments.get(kpi_id)
            if existing_pillar_id is not None and existing_pillar_id != pillar_id:
                raise ValueError(
                    f"Conflicting pillar mappings for {kpi_id}: "
                    f"{existing_pillar_id} and {pillar_id}"
                )
            assignments[kpi_id] = pillar_id
    return assignments


_KPI_PILLAR_IDS = _load_kpi_pillar_ids()

_KNOWN_KPI_IDS = sorted({
    kpi_id
    for kpi_ids in MAIN_CATEGORY_TO_KPI_COLUMNS.values()
    for kpi_id in kpi_ids
})

KPI_DEFINITIONS: list[KpiDefinition] = [
    KpiDefinition(
        kpi_id=kpi_id,
        kpi_name=_KPI_NAME_AND_UNIT.get(kpi_id, (None, None))[0],
        input_unit=_KPI_NAME_AND_UNIT.get(kpi_id, (None, None))[1],
        pillar_id=_KPI_PILLAR_IDS.get(kpi_id),
    )
    for kpi_id in _KNOWN_KPI_IDS
]

# One KPI_VERSION per KPI_DEFINITION, for schema completeness and reuse by future
# ENGINE_CALCULATED zones. SAZ (SOURCE_PROVIDED) never uses the scoring fields
# (max_score, scoring_method, direction, floor_value, target_value) since it
# never recalculates a per-KPI score -- they stay unset here. period_granularity
# is a factual attribute (SAZ reports monthly), not a scoring rule, so it is set.
KPI_VERSIONS: list[KpiVersion] = [
    KpiVersion(
        kpi_version_id=f"{kpi_id}_SAZ_V1",
        kpi_id=kpi_id,
        period_granularity="MONTHLY",
        effective_from=date(2026, 1, 1),
    )
    for kpi_id in _KNOWN_KPI_IDS
]

# Resolves KPI_INPUT.kpi_id to its effective KPI_VERSION. SAZ has exactly one
# version per KPI; a zone with re-versioned scoring rules must resolve by
# reporting_period against effective_from/effective_to instead.
KPI_VERSION_ID_BY_KPI_ID: dict[str, str] = {
    version.kpi_id: version.kpi_version_id for version in KPI_VERSIONS
}

