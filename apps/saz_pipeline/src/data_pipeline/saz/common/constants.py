"""
Shared enums and constants used across all SAZ pipeline Pydantic models.
"""

from enum import Enum


class ApplicabilityStatus(str, Enum):
    APPLICABLE = "Applicable"
    NOT_APPLICABLE = "Not Applicable"


class CalculationSource(str, Enum):
    SOURCE_PROVIDED = "SOURCE_PROVIDED"


SCORECARD_ID = "SAZ_SPM_CALCULATION"

# main_category -> dedicated Databricks source table (split per category, same wide schema).
MAIN_CATEGORY_TO_TABLE = {
    "BST": "brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_bst",
    "Capex MRO": "brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_capex_mro",
    "Brand Act Commercial": "brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_brand_act_commercial",
    "Brand Commercials": "brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_brand_commercials",
    "Directs": "brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_directs",
}

# main_category -> which overall_score* column the source uses for SCORECARD_INPUT.
MAIN_CATEGORY_TO_SCORECARD_COLUMN = {
    "BST": "overall_score",
    "Brand Act Commercial": "overall_score",
    "Brand Commercials": "overall_score",
    "Capex MRO": "overall_score_indirects",
    "Directs": "overall_score_directs",
}

# main_category -> which service_level_* column the source uses (None = no Service Level pillar row).
MAIN_CATEGORY_TO_SERVICE_LEVEL_COLUMN = {
    "BST": None,
    "Brand Act Commercial": None,
    "Brand Commercials": None,
    "Capex MRO": "service_level_indirects",
    "Directs": "service_level_directs",
}

# Sustainability pillar column is populated for all 5 main_category values.
SUSTAINABILITY_COLUMN = "sustainability"

# main_category -> which operational column the source uses (None = no Operational pillar row).
MAIN_CATEGORY_TO_OPERATIONAL_COLUMN = {
    "BST": "operational",
    "Brand Act Commercial": "operational",
    "Brand Commercials": None,
    "Capex MRO": "operational",
    "Directs": "operational",
}

# Value Creation pillar: BST populates value_generation_formula, all others populate
# value_generation; the two are never populated simultaneously, so try both in order.
VALUE_CREATION_COLUMNS = ("value_generation", "value_generation_formula")

# main_category -> populated KPI source columns (confirmed via direct Databricks inspection).
MAIN_CATEGORY_TO_KPI_COLUMNS = {
    "BST": [
        "ns", "acceptance_term", "cost", "cash_flow", "engagement", "price", "upload_nf",
        "turnover", "absenteeism", "satisfaction", "gps", "bees_tasks", "sla_vacancies",
        "blank_route", "invoice_compliance_po_not_found", "deloitte_compliance",
        "turnover_perception", "contract_compliance_tech", "quality_tech",
    ],
    "Brand Act Commercial": [
        "ns", "acceptance_term", "cost", "cash_flow", "engagement", "invoice_compliance",
        "price", "upload_nf", "ontime_production", "recall", "recall_ontime",
        "quality_recall_ontime_recall", "docs_nok_media_system", "events_audit",
        "contract_compliance",
    ],
    "Brand Commercials": [
        "ns", "nps", "media_tools", "cac", "cpo", "ratio_prod", "extra_cost", "op",
        "media_system", "acceptance_term", "cash_flow",
    ],
    "Capex MRO": [
        "acceptance_term", "cost", "cash_flow", "engagement", "mtf_total", "mtf_audit",
        "mtf_leadtime", "mtf_tickets", "mtf_audit_div", "mtf_on_time", "project_nps",
        "ariba_adherence", "invoice_compliance", "price", "upload_nf", "eclipse_adherence",
    ],
    "Directs": [
        "acceptance_term", "cost", "cash_flow", "engagement", "price", "eclipse_adherence",
        "invoice_compliance_po_not_found", "quality_cars", "quality_documentation",
        "order_acceptance_rate", "otif",
    ],
}
