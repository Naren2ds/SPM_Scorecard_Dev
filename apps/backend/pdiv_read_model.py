"""Server-side Price Divergence calculation and lightweight API read model."""

from __future__ import annotations

import csv
import io
import math
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator


PDIV_LEVELS = {"parent", "supplier", "zone", "category"}
PDIV_FORMULA_MODES = {"softStretch", "strict"}
PDIV_SORT_FIELDS = {
    "label",
    "normalizedDivergence",
    "rankAscending",
    "percentile",
    "attainmentFactor",
    "earnedScore",
    "scorePercent",
    "contributingRows",
}


@dataclass(frozen=True, slots=True)
class PdivConfig:
    max_score: float
    critical_floor: float
    target: float
    formula_mode: str = "softStretch"

    def as_api_dict(self) -> dict[str, Any]:
        return {
            "maxScore": self.max_score,
            "criticalFloor": self.critical_floor,
            "target": self.target,
            "formulaMode": self.formula_mode,
        }


@dataclass(frozen=True, slots=True)
class RawPdivValues:
    po_value: float
    invoice_value: float
    absolute_difference: float


@dataclass(slots=True)
class PdivAssessment:
    row: dict[str, Any]
    row_number: int
    is_applicable: bool
    normalized_divergence: float | None
    raw_values: RawPdivValues
    is_valid: bool


@dataclass(slots=True)
class PdivSupplierResult:
    assessment: PdivAssessment
    rank: float | None
    percentile: float | None
    rank_note: str | None
    attainment: float | None
    earned: float | None
    score_status: str

    @property
    def label(self) -> str:
        return _text(self.assessment.row.get("supplier")) or f"Row {self.assessment.row_number}"

    @property
    def normalized_divergence(self) -> float | None:
        return self.assessment.normalized_divergence


@dataclass(slots=True)
class PdivRollupResult:
    level: str
    label: str
    country: str
    normalized_divergence: float
    raw_values: RawPdivValues
    contributing_rows: int
    rank: float | None = None
    percentile: float | None = None
    rank_note: str | None = None
    attainment: float | None = None
    earned: float | None = None
    score_status: str = "Missing Data"


@dataclass(slots=True)
class _RollupAccumulator:
    count: int = 0
    po_value: float = 0.0
    invoice_value: float = 0.0
    absolute_difference: float = 0.0
    countries: set[str] = field(default_factory=set)


@dataclass(slots=True)
class PdivReadModel:
    config: PdivConfig
    filters: dict[str, tuple[str, ...]]
    source_row_count: int
    cohort_row_count: int
    assessments: list[PdivAssessment]
    parent_results: list[PdivRollupResult]
    parent_index: dict[str, PdivRollupResult]
    _supplier_results: list[PdivSupplierResult] | None = field(default=None, repr=False)
    _zone_results: list[PdivRollupResult] | None = field(default=None, repr=False)
    _category_results: list[PdivRollupResult] | None = field(default=None, repr=False)
    _lazy_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def supplier_results(self) -> list[PdivSupplierResult]:
        if self._supplier_results is None:
            with self._lazy_lock:
                if self._supplier_results is None:
                    self._supplier_results = _score_suppliers(self.assessments, self.config)
        return self._supplier_results

    @property
    def zone_results(self) -> list[PdivRollupResult]:
        if self._zone_results is None:
            with self._lazy_lock:
                if self._zone_results is None:
                    self._zone_results = _build_rollups(self.assessments, "zone", self.config)
        return self._zone_results

    @property
    def category_results(self) -> list[PdivRollupResult]:
        if self._category_results is None:
            with self._lazy_lock:
                if self._category_results is None:
                    self._category_results = _build_rollups(self.assessments, "category", self.config)
        return self._category_results

    def level_rows(self, level: str) -> list[PdivSupplierResult] | list[PdivRollupResult]:
        if level == "supplier":
            return self.supplier_results
        if level == "zone":
            return self.zone_results
        if level == "category":
            return self.category_results
        return self.parent_results


def validate_pdiv_config(config: PdivConfig) -> list[str]:
    errors: list[str] = []
    if not math.isfinite(config.max_score) or config.max_score <= 0:
        errors.append("Max Score must be greater than 0.")
    if not math.isfinite(config.critical_floor) or not 0 <= config.critical_floor <= 1:
        errors.append("Critical Floor must be between 0% and 100%.")
    if not math.isfinite(config.target) or not 0 <= config.target <= 1:
        errors.append("Target must be between 0% and 100%.")
    if (
        math.isfinite(config.critical_floor)
        and math.isfinite(config.target)
        and config.critical_floor <= config.target
    ):
        errors.append("Critical Floor must be greater than Target for Price Divergence.")
    if config.formula_mode not in PDIV_FORMULA_MODES:
        errors.append("Formula Mode must be softStretch or strict.")
    return errors


def normalize_pdiv_filters(filters: dict[str, Iterable[str]] | None = None) -> dict[str, tuple[str, ...]]:
    source = filters or {}
    return {
        key: tuple(sorted({_text(value) for value in source.get(key, []) if _text(value)}))
        for key in ("categories", "years", "months", "countries", "zones")
    }


def pdiv_filter_key(filters: dict[str, Iterable[str]] | None = None) -> tuple[tuple[str, ...], ...]:
    normalized = normalize_pdiv_filters(filters)
    return tuple(normalized[key] for key in ("categories", "years", "months", "countries", "zones"))


def list_pdiv_filter_options(rows: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    values = {key: set() for key in ("categories", "years", "months", "countries", "zones")}
    fields = {
        "categories": "category",
        "years": "year",
        "months": "month",
        "countries": "country",
        "zones": "zone",
    }
    for row in rows:
        for key, field_name in fields.items():
            value = _text(row.get(field_name))
            if value:
                values[key].add(value)
    return {
        "categories": sorted(values["categories"]),
        "years": sorted(values["years"], key=_numeric_sort_key),
        "months": sorted(values["months"], key=_numeric_sort_key),
        "countries": sorted(values["countries"]),
        "zones": sorted(values["zones"]),
    }


def build_pdiv_read_model(
    rows: list[dict[str, Any]],
    config: PdivConfig,
    filters: dict[str, Iterable[str]] | None = None,
) -> PdivReadModel:
    errors = validate_pdiv_config(config)
    if errors:
        raise ValueError(" ".join(errors))
    normalized_filters = normalize_pdiv_filters(filters)
    cohort_rows = [row for row in rows if _passes_filters(row, normalized_filters)]
    assessments = [_assess_row(row, index + 1) for index, row in enumerate(cohort_rows)]
    parent_results = _build_rollups(assessments, "parent", config)
    return PdivReadModel(
        config=config,
        filters=normalized_filters,
        source_row_count=len(rows),
        cohort_row_count=len(cohort_rows),
        assessments=assessments,
        parent_results=parent_results,
        parent_index={row.label: row for row in parent_results},
    )


def reconfigure_pdiv_read_model(model: PdivReadModel, config: PdivConfig) -> PdivReadModel:
    errors = validate_pdiv_config(config)
    if errors:
        raise ValueError(" ".join(errors))
    parent_results = _build_rollups(model.assessments, "parent", config)
    return PdivReadModel(
        config=config,
        filters=model.filters,
        source_row_count=model.source_row_count,
        cohort_row_count=model.cohort_row_count,
        assessments=model.assessments,
        parent_results=parent_results,
        parent_index={row.label: row for row in parent_results},
    )


def _scoped_level_rows(
    model: PdivReadModel,
    level: str,
    parents: Iterable[str] | None = None,
) -> list[PdivSupplierResult] | list[PdivRollupResult]:
    parent_set = {_text(value) for value in (parents or []) if _text(value)}
    if not parent_set:
        return model.level_rows(level)
    if level == "parent":
        return [row for row in model.parent_results if row.label in parent_set]
    if level == "supplier":
        return [
            row for row in model.supplier_results
            if _text(row.assessment.row.get("parentSupplier")) in parent_set
        ]
    assessments = [
        row for row in model.assessments
        if _text(row.row.get("parentSupplier")) in parent_set
    ]
    return _build_rollups(assessments, level, model.config)


def query_pdiv_results(
    model: PdivReadModel,
    *,
    level: str,
    search: str = "",
    parents: Iterable[str] | None = None,
    suppliers: Iterable[str] | None = None,
    sort: str = "rankAscending",
    order: str = "asc",
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    if level not in PDIV_LEVELS:
        raise ValueError(f"Unsupported Price Divergence result level: {level}")
    if sort not in PDIV_SORT_FIELDS:
        raise ValueError(f"Unsupported Price Divergence sort field: {sort}")
    if order not in {"asc", "desc"}:
        raise ValueError("Price Divergence sort order must be asc or desc")

    supplier_set = {_text(value) for value in (suppliers or []) if _text(value)}
    query = search.strip().casefold()
    rows = list(_scoped_level_rows(model, level, parents))
    if level == "supplier":
        if supplier_set:
            rows = [row for row in rows if row.label in supplier_set]
        if query:
            rows = [
                row for row in rows
                if query in row.label.casefold()
                or query in _text(row.assessment.row.get("parentSupplier")).casefold()
            ]
    elif query:
        rows = [row for row in rows if query in row.label.casefold()]

    rows = _sort_results(rows, sort, order)
    total_items = len(rows)
    total_pages = math.ceil(total_items / page_size) if total_items else 0
    start = (page - 1) * page_size
    return {
        "items": [serialize_pdiv_result(row, model.config) for row in rows[start:start + page_size]],
        "page": page,
        "page_size": page_size,
        "total_items": total_items,
        "total_pages": total_pages,
        "level": level,
        "sort": sort,
        "order": order,
    }


def summarize_pdiv_model(
    model: PdivReadModel,
    level: str = "parent",
    parents: Iterable[str] | None = None,
    suppliers: Iterable[str] | None = None,
    search: str = "",
) -> dict[str, Any]:
    supplier_set = {_text(value) for value in (suppliers or []) if _text(value)}
    query = search.strip().casefold()
    rows = list(_scoped_level_rows(model, level, parents))
    if level == "supplier":
        if supplier_set:
            rows = [row for row in rows if row.label in supplier_set]
        if query:
            rows = [
                row for row in rows
                if query in row.label.casefold()
                or query in _text(row.assessment.row.get("parentSupplier")).casefold()
            ]
    elif query:
        rows = [row for row in rows if query in row.label.casefold()]

    valid = [row for row in rows if row.normalized_divergence is not None]
    earned = [row.earned for row in rows if row.earned is not None]
    status_counts: dict[str, int] = {}
    for row in rows:
        status_counts[row.score_status] = status_counts.get(row.score_status, 0) + 1
    return {
        "level": level,
        "source_row_count": model.source_row_count,
        "cohort_row_count": model.cohort_row_count,
        "result_count": len(rows),
        "valid_result_count": len(valid),
        "average_divergence_pct": round(
            sum(row.normalized_divergence for row in valid if row.normalized_divergence is not None)
            / len(valid) * 100,
            2,
        ) if valid else 0.0,
        "average_earned_score": round(sum(earned) / len(earned), 4) if earned else 0.0,
        "status_counts": status_counts,
        "config": model.config.as_api_dict(),
        "filters_applied": {key: list(values) for key, values in model.filters.items()},
    }


def search_pdiv_results(
    model: PdivReadModel,
    *,
    level: str,
    query: str,
    limit: int,
    parents: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
    text = query.strip().casefold()
    if len(text) < 2:
        return []
    if level == "supplier":
        names: dict[str, str] = {}
        for result in _scoped_level_rows(model, level, parents):
            parent = _text(result.assessment.row.get("parentSupplier"))
            if text in result.label.casefold():
                names.setdefault(result.label, parent)
        return [
            {"label": supplier, "parentSupplier": names[supplier]}
            for supplier in sorted(names, key=str.casefold)[:limit]
        ]
    rows = _scoped_level_rows(model, level, parents)
    matches = [row for row in rows if text in row.label.casefold()]
    matches.sort(key=lambda row: row.label.casefold())
    return [
        {
            "label": row.label,
            "normalizedDivergence": row.normalized_divergence,
            "earnedScore": row.earned,
            "scoreStatus": row.score_status,
        }
        for row in matches[:limit]
    ]


def serialize_pdiv_result(
    result: PdivSupplierResult | PdivRollupResult,
    config: PdivConfig,
) -> dict[str, Any]:
    if isinstance(result, PdivSupplierResult):
        assessment = result.assessment
        row = assessment.row
        return {
            "id": _text(row.get("id")) or f"row-{assessment.row_number}",
            "level": "supplier",
            "label": result.label,
            "supplier": _text(row.get("supplier")),
            "parentSupplier": _text(row.get("parentSupplier")),
            "zone": _text(row.get("zone")),
            "country": _text(row.get("country")),
            "category": _text(row.get("category")),
            "year": _text(row.get("year")),
            "month": _text(row.get("month")),
            "poValue": assessment.raw_values.po_value,
            "invoiceValue": assessment.raw_values.invoice_value,
            "absoluteDifference": assessment.raw_values.absolute_difference,
            "normalizedDivergence": assessment.normalized_divergence,
            "rankAscending": result.rank,
            "percentile": result.percentile,
            "criticalFloor": config.critical_floor,
            "target": config.target,
            "attainmentFactor": result.attainment,
            "maxScore": config.max_score,
            "earnedScore": result.earned,
            "scorePercent": result.earned / config.max_score if result.earned is not None else None,
            "scoreStatus": result.score_status,
            "contributingRows": 1 if assessment.is_valid else 0,
            "explanation": _explanation(
                assessment.normalized_divergence,
                result.rank_note,
                result.percentile,
                result.attainment,
                result.earned,
                result.score_status,
                config,
            ),
        }

    return {
        "id": f"{result.level}-{result.label}",
        "level": result.level,
        "label": result.label,
        "parentSupplier": result.label if result.level == "parent" else "All parents",
        "zone": result.label if result.level == "zone" else "All zones",
        "country": result.country,
        "poValue": result.raw_values.po_value,
        "invoiceValue": result.raw_values.invoice_value,
        "absoluteDifference": result.raw_values.absolute_difference,
        "normalizedDivergence": result.normalized_divergence,
        "rankAscending": result.rank,
        "percentile": result.percentile,
        "criticalFloor": config.critical_floor,
        "target": config.target,
        "attainmentFactor": result.attainment,
        "maxScore": config.max_score,
        "earnedScore": result.earned,
        "scorePercent": result.earned / config.max_score if result.earned is not None else None,
        "scoreStatus": result.score_status,
        "contributingRows": result.contributing_rows,
        "explanation": _explanation(
            result.normalized_divergence,
            result.rank_note,
            result.percentile,
            result.attainment,
            result.earned,
            result.score_status,
            config,
            contributing_rows=result.contributing_rows,
        ),
    }


def iter_pdiv_csv(
    model: PdivReadModel,
    *,
    parents: Iterable[str] | None = None,
    suppliers: Iterable[str] | None = None,
) -> Iterator[str]:
    supplier_set = {_text(value) for value in (suppliers or []) if _text(value)}
    results = list(_scoped_level_rows(model, "supplier", parents))
    if supplier_set:
        results = [row for row in results if row.label in supplier_set]
    results = _sort_results(results, "rankAscending", "asc")
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")

    def emit(values: list[Any]) -> str:
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow(values)
        return buffer.getvalue()

    config = model.config
    yield emit(["Price Divergence KPI Config"])
    yield emit(["Max Score", config.max_score])
    yield emit(["Floor %", _format_percent(config.critical_floor, 2)])
    yield emit(["Target %", _format_percent(config.target, 2)])
    yield emit(["Rows", len(results)])
    yield emit([])
    yield emit(["Supplier Level"])
    yield emit([
        "Supplier", "Parent", "Zone", "Country", "Category", "Year", "Month",
        "PO Value", "Invoice Value", "Absolute Difference", "Divergence %", "Rank",
        "Percentile", "Attainment", "Max", "Earned", "Score %", "Status",
    ])
    for result in results:
        row = serialize_pdiv_result(result, config)
        yield emit([
            row["supplier"], row["parentSupplier"], row["zone"], row["country"],
            row["category"], row["year"], row["month"],
            _format_number(row["poValue"], 2), _format_number(row["invoiceValue"], 2),
            _format_number(row["absoluteDifference"], 2),
            _format_percent(row["normalizedDivergence"], 2),
            _format_rank(row["rankAscending"]), _format_percent(row["percentile"], 2),
            _format_number(row["attainmentFactor"], 4), _format_number(row["maxScore"], 2),
            _format_number(row["earnedScore"], 2), _format_percent(row["scorePercent"], 2),
            row["scoreStatus"],
        ])


def _assess_row(row: dict[str, Any], row_number: int) -> PdivAssessment:
    applicable = _text(row.get("kpiApplicability") or "Applicable").casefold() != "not applicable"
    po_value = _to_number(row.get("poValue"))
    invoice_value = _to_number(row.get("invoiceValue"))
    valid = applicable and po_value is not None and invoice_value is not None and po_value > 0
    po = po_value or 0.0
    invoice = invoice_value or 0.0
    absolute_difference = abs(invoice - po) if po_value is not None and invoice_value is not None else 0.0
    normalized = absolute_difference / po if valid else None
    return PdivAssessment(
        row=row,
        row_number=row_number,
        is_applicable=applicable,
        normalized_divergence=normalized,
        raw_values=RawPdivValues(po, invoice, absolute_difference),
        is_valid=valid,
    )


def _score_suppliers(
    assessments: list[PdivAssessment],
    config: PdivConfig,
) -> list[PdivSupplierResult]:
    valid = [
        (index, row.normalized_divergence)
        for index, row in enumerate(assessments)
        if row.is_valid and row.normalized_divergence is not None
    ]
    ranks = _percentile_ranks(valid, config.target)
    results: list[PdivSupplierResult] = []
    for index, assessment in enumerate(assessments):
        if not assessment.is_applicable:
            results.append(PdivSupplierResult(assessment, None, None, None, None, None, "Not Applicable"))
            continue
        if not assessment.is_valid or assessment.normalized_divergence is None:
            results.append(PdivSupplierResult(assessment, None, None, None, None, None, "Missing Data"))
            continue
        rank, percentile, note = ranks[index]
        attainment = _attainment(assessment.normalized_divergence, config)
        earned = _earned(config, percentile, attainment)
        status = "Below critical floor" if assessment.normalized_divergence >= config.critical_floor else "Valid score"
        results.append(PdivSupplierResult(assessment, rank, percentile, note, attainment, earned, status))
    return results


def _build_rollups(
    assessments: list[PdivAssessment],
    level: str,
    config: PdivConfig,
) -> list[PdivRollupResult]:
    groups: dict[str, _RollupAccumulator] = {}
    for assessment in assessments:
        if not assessment.is_valid:
            continue
        label = _rollup_label(assessment.row, level)
        accumulator = groups.setdefault(label, _RollupAccumulator())
        accumulator.count += 1
        accumulator.po_value += assessment.raw_values.po_value
        accumulator.invoice_value += assessment.raw_values.invoice_value
        accumulator.absolute_difference += assessment.raw_values.absolute_difference
        country = _text(assessment.row.get("country"))
        if country:
            accumulator.countries.add(country)

    results: list[PdivRollupResult] = []
    for label, accumulator in groups.items():
        if accumulator.po_value <= 0:
            continue
        results.append(PdivRollupResult(
            level=level,
            label=label,
            country=next(iter(accumulator.countries)) if len(accumulator.countries) == 1 else "Multiple",
            normalized_divergence=accumulator.absolute_difference / accumulator.po_value,
            raw_values=RawPdivValues(
                accumulator.po_value,
                accumulator.invoice_value,
                accumulator.absolute_difference,
            ),
            contributing_rows=accumulator.count,
        ))

    ranks = _percentile_ranks(
        [(index, row.normalized_divergence) for index, row in enumerate(results)],
        config.target,
    )
    for index, result in enumerate(results):
        rank, percentile, note = ranks[index]
        attainment = _attainment(result.normalized_divergence, config)
        result.rank = rank
        result.percentile = percentile
        result.rank_note = note
        result.attainment = attainment
        result.earned = _earned(config, percentile, attainment)
        result.score_status = "Below critical floor" if result.normalized_divergence >= config.critical_floor else "Valid score"
    return results


def _percentile_ranks(
    valid_rows: list[tuple[int, float | None]],
    target: float,
) -> dict[int, tuple[float, float, str]]:
    values = [(index, value) for index, value in valid_rows if value is not None]
    count = len(values)
    if count == 0:
        return {}
    if count == 1:
        return {values[0][0]: (1.0, 1.0, "single")}
    distinct = {_pdiv_key(value) for _, value in values}
    if len(distinct) == 1:
        shared = values[0][1]
        # Preserve the existing scorecard special-case rule exactly.
        percentile = 1.0 if shared >= target else 0.5
        average_rank = (count + 1) / 2
        return {index: (average_rank, percentile, "noVariance") for index, _ in values}

    sorted_rows = sorted(values, key=lambda item: item[1])
    ranks: dict[int, tuple[float, float, str]] = {}
    cursor = 0
    while cursor < count:
        current = _pdiv_key(sorted_rows[cursor][1])
        end = cursor + 1
        while end < count and _pdiv_key(sorted_rows[end][1]) == current:
            end += 1
        average_rank = (cursor + 1 + end) / 2
        percentile = (count - average_rank) / (count - 1)
        for position in range(cursor, end):
            ranks[sorted_rows[position][0]] = (average_rank, percentile, "standard")
        cursor = end
    return ranks


def _attainment(divergence: float, config: PdivConfig) -> float:
    if divergence <= config.target:
        return 1.0
    if divergence >= config.critical_floor:
        return 0.0
    return max(
        0.0,
        min(1.0, (config.critical_floor - divergence) / (config.critical_floor - config.target)),
    )


def _earned(config: PdivConfig, percentile: float, attainment: float) -> float:
    if config.formula_mode == "softStretch":
        return config.max_score * attainment * (0.7 + 0.3 * percentile)
    return config.max_score * percentile * attainment


def _explanation(
    divergence: float | None,
    rank_note: str | None,
    percentile: float | None,
    attainment: float | None,
    earned: float | None,
    status: str,
    config: PdivConfig,
    *,
    contributing_rows: int | None = None,
) -> str:
    if status == "Not Applicable":
        return "Not applicable: excluded from ranking and scoring."
    if divergence is None or percentile is None or attainment is None or earned is None:
        return "Missing data: PO Value must be greater than zero and both values must be numeric."
    messages: list[str] = []
    if rank_note == "single":
        messages.append("Single observation: percentile set to 100% by rule.")
    elif rank_note == "noVariance":
        messages.append("No variance: all results have the same divergence value.")
    if status == "Below critical floor":
        messages.append(
            f"Below critical floor: divergence {divergence * 100:.2f}% >= floor {config.critical_floor * 100:.2f}%. Attainment = 0, earned score = 0."
        )
    else:
        messages.append(f"Valid score: divergence {divergence * 100:.2f}%. Attainment = {attainment:.4f}.")
        if config.formula_mode == "softStretch":
            messages.append(
                f"Earned Score = {config.max_score:.2f} x {attainment:.4f} x (70% + 30% x {percentile * 100:.2f}%) = {earned:.2f}."
            )
        else:
            messages.append(
                f"Earned Score = {config.max_score:.2f} x {percentile * 100:.2f}% x {attainment:.4f} = {earned:.2f}."
            )
    if contributing_rows is not None:
        messages.append(
            f"Production rollup uses sum of {contributing_rows} row-level absolute differences divided by summed PO Value."
        )
    return " ".join(messages)


def _sort_results(rows: list[Any], sort: str, order: str) -> list[Any]:
    def value(row: Any) -> Any:
        if sort == "label":
            return row.label.casefold()
        if sort == "contributingRows" and isinstance(row, PdivSupplierResult):
            return 1 if row.assessment.is_valid else 0
        attribute = {
            "normalizedDivergence": "normalized_divergence",
            "rankAscending": "rank",
            "percentile": "percentile",
            "attainmentFactor": "attainment",
            "earnedScore": "earned",
            "scorePercent": "earned",
            "contributingRows": "contributing_rows",
        }[sort]
        return getattr(row, attribute, None)

    present = [row for row in rows if value(row) is not None]
    missing = [row for row in rows if value(row) is None]
    present.sort(key=lambda row: row.label.casefold())
    present.sort(key=value, reverse=order == "desc")
    return present + missing


def _passes_filters(row: dict[str, Any], filters: dict[str, tuple[str, ...]]) -> bool:
    fields = {
        "categories": "category",
        "years": "year",
        "months": "month",
        "countries": "country",
        "zones": "zone",
    }
    for key, field_name in fields.items():
        selected = filters[key]
        value = _text(row.get(field_name))
        if key == "months":
            value = _normalize_month(value)
            selected = tuple(_normalize_month(item) for item in selected)
        if selected and value not in selected:
            return False
    return True


def _rollup_label(row: dict[str, Any], level: str) -> str:
    field_name = {"parent": "parentSupplier", "zone": "zone", "category": "category"}[level]
    fallback = {"parent": "Unassigned parent", "zone": "Unassigned zone", "category": "Unassigned category"}[level]
    return _text(row.get(field_name)) or fallback


def _to_number(value: Any) -> float | None:
    text = _text(value).replace(",", "").replace("%", "")
    if not text:
        return None
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_month(value: str) -> str:
    stripped = value.lstrip("0")
    return stripped or "0"


def _numeric_sort_key(value: str) -> tuple[int, float | str]:
    try:
        return (0, float(value))
    except ValueError:
        return (1, value.casefold())


def _pdiv_key(value: float | None) -> str:
    return f"{value:.12f}" if value is not None else ""


def _format_percent(value: float | None, digits: int) -> str:
    return "-" if value is None else f"{value * 100:.{digits}f}%"


def _format_number(value: float | None, digits: int) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def _format_rank(value: float | None) -> str:
    if value is None:
        return "-"
    return str(int(value)) if value.is_integer() else f"{value:.2f}"
