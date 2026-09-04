"""
Temporary smoke test (NOT part of the pipeline codebase) verifying the four
Pydantic models import and validate correctly with realistic sample data.
Delete after use.
"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from data_pipeline.saz.load_supplier.models import SupplierRecord
from data_pipeline.saz.load_kpi_input.models import KpiInputRecord
from data_pipeline.saz.load_pillar_input.models import PillarInputRecord
from data_pipeline.saz.load_scorecard_input.models import ScorecardInputRecord
from data_pipeline.saz.common.constants import ApplicabilityStatus

supplier = SupplierRecord(
    supplier_id="GR GARANTIA DE SERVICOS",
    parent_supplier_id="GR GARANTIA DE SERVICOS",
    parent_supplier_name="GR GARANTIA DE SERVICOS",
    vendor_name="NA",
    scorecard_category="BST",
    saz_category="BST",
    sub_category="SERVICES",
)
print("SupplierRecord OK:", supplier.model_dump())

kpi_input = KpiInputRecord(
    kpi_input_id="BST-GR GARANTIA DE SERVICOS-turnover-202607",
    supplier_id="GR GARANTIA DE SERVICOS",
    kpi_id="turnover",
    reporting_period=date(2026, 7, 1),
    period_start_date=date(2026, 7, 1),
    period_end_date=date(2026, 7, 31),
    input_value=0.29,
    applicability_status=ApplicabilityStatus.APPLICABLE,
    source_reference="july_2026_main_category_bst.xlsx",
)
print("KpiInputRecord OK:", kpi_input.model_dump())

pillar_input = PillarInputRecord(
    pillar_input_id="SAZ-PARENT-GRGARANTIA-SUSTAINABILITY-202607",
    parent_supplier_id="PARENT-GRGARANTIA",
    pillar_id="SUSTAINABILITY",
    reporting_period=date(2026, 7, 1),
    source_pillar_score_pct=817.0,
    source_reference="july_2026_main_category_bst.xlsx",
)
print("PillarInputRecord OK:", pillar_input.model_dump())

scorecard_input = ScorecardInputRecord(
    scorecard_input_id="SAZ-PARENT-GRGARANTIA-202607",
    parent_supplier_id="PARENT-GRGARANTIA",
    reporting_period=date(2026, 7, 1),
    source_normalized_score=708.0,
    source_reference="july_2026_main_category_bst.xlsx",
)
print("ScorecardInputRecord OK:", scorecard_input.model_dump())

# Negative input_value is allowed (some KPI columns, e.g. cash_flow, are variance-style).
negative_kpi_input = KpiInputRecord(
    kpi_input_id="bad",
    supplier_id="bad",
    kpi_id="bad",
    reporting_period=date(2026, 7, 1),
    period_start_date=date(2026, 7, 1),
    period_end_date=date(2026, 7, 31),
    input_value=-8.0,
    applicability_status=ApplicabilityStatus.APPLICABLE,
    source_reference="x",
)
print("Negative input_value correctly allowed:", negative_kpi_input.input_value)
