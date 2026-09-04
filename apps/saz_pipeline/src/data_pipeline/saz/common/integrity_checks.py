"""
Referential integrity checks between the SAZ input records (SUPPLIER, KPI_INPUT,
PILLAR_INPUT, SCORECARD_INPUT) and the configuration data (SCORECARD_DEFINITION,
PILLAR_DEFINITION, KPI catalogue), run before the promotion job.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..load_kpi_input.models import KpiInputRecord
from ..load_pillar_input.models import PillarInputRecord
from ..load_scorecard_input.models import ScorecardInputRecord
from ..load_supplier.models import SupplierRecord
from .configuration import KPI_DEFINITIONS, PILLAR_DEFINITIONS, SCORECARD_DEFINITIONS


@dataclass
class IntegrityReport:
    unknown_scorecard_ids: set[str] = field(default_factory=set)
    unknown_pillar_ids: set[str] = field(default_factory=set)
    orphan_pillar_input_suppliers: set[str] = field(default_factory=set)
    orphan_scorecard_input_suppliers: set[str] = field(default_factory=set)
    orphan_kpi_input_suppliers: set[str] = field(default_factory=set)
    unknown_kpi_ids: set[str] = field(default_factory=set)

    @property
    def passed(self) -> bool:
        return not any((
            self.unknown_scorecard_ids,
            self.unknown_pillar_ids,
            self.orphan_pillar_input_suppliers,
            self.orphan_scorecard_input_suppliers,
            self.orphan_kpi_input_suppliers,
            self.unknown_kpi_ids,
        ))

    def summary(self) -> str:
        if self.passed:
            return "PASS: all referential integrity checks passed."

        lines = ["FAIL: referential integrity issues found:"]
        if self.unknown_scorecard_ids:
            lines.append(f"  - Unknown scorecard_id in SCORECARD_INPUT: {sorted(self.unknown_scorecard_ids)}")
        if self.unknown_pillar_ids:
            lines.append(f"  - Unknown pillar_id in PILLAR_INPUT: {sorted(self.unknown_pillar_ids)}")
        if self.orphan_pillar_input_suppliers:
            lines.append(f"  - PILLAR_INPUT rows with no matching SUPPLIER: {len(self.orphan_pillar_input_suppliers)} supplier(s)")
        if self.orphan_scorecard_input_suppliers:
            lines.append(f"  - SCORECARD_INPUT rows with no matching SUPPLIER: {len(self.orphan_scorecard_input_suppliers)} supplier(s)")
        if self.orphan_kpi_input_suppliers:
            lines.append(f"  - KPI_INPUT rows with no matching SUPPLIER: {len(self.orphan_kpi_input_suppliers)} supplier(s)")
        if self.unknown_kpi_ids:
            lines.append(f"  - Unknown kpi_id in KPI_INPUT (not in KPI catalogue): {sorted(self.unknown_kpi_ids)}")
        return "\n".join(lines)


def check_referential_integrity(
    suppliers: list[SupplierRecord],
    kpi_inputs: list[KpiInputRecord],
    pillar_inputs: list[PillarInputRecord],
    scorecard_inputs: list[ScorecardInputRecord],
) -> IntegrityReport:
    """Validate that every input record links to a real configuration/supplier entry."""
    known_scorecard_ids = {definition.scorecard_id for definition in SCORECARD_DEFINITIONS}
    known_pillar_ids = {definition.pillar_id for definition in PILLAR_DEFINITIONS}
    known_kpi_ids = {definition.kpi_id for definition in KPI_DEFINITIONS}
    known_supplier_ids = {record.supplier_id for record in suppliers}

    report = IntegrityReport()

    for record in scorecard_inputs:
        if record.scorecard_id not in known_scorecard_ids:
            report.unknown_scorecard_ids.add(record.scorecard_id)
        if record.parent_supplier_id not in known_supplier_ids:
            report.orphan_scorecard_input_suppliers.add(record.parent_supplier_id)

    for record in pillar_inputs:
        if record.pillar_id not in known_pillar_ids:
            report.unknown_pillar_ids.add(record.pillar_id)
        if record.parent_supplier_id not in known_supplier_ids:
            report.orphan_pillar_input_suppliers.add(record.parent_supplier_id)

    for record in kpi_inputs:
        if record.supplier_id not in known_supplier_ids:
            report.orphan_kpi_input_suppliers.add(record.supplier_id)
        if record.kpi_id not in known_kpi_ids:
            report.unknown_kpi_ids.add(record.kpi_id)

    return report
