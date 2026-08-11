"""Server-side IOT calculation and lightweight API read model."""

from __future__ import annotations

import csv
import io
import math
import threading
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator


IOT_LEVELS = {"parent", "supplier", "zone", "category"}
IOT_FORMULA_MODES = {"softStretch", "strict"}
IOT_SORT_FIELDS = {
    "label",
    "normalizedIot",
    "rankDescending",
    "percentile",
    "attainmentFactor",
    "earnedScore",
    "scorePercent",
    "contributingRows",
}


@dataclass(frozen=True, slots=True)
class IotConfig:
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
class RawIotValues:
    invoice_on_time: float
    total_po_lines: float


@dataclass(slots=True)
class IotAssessment:
    row: dict[str, Any]
    row_number: int
    is_applicable: bool
    normalized_iot: float | None
    raw_values: RawIotValues
    is_valid: bool


@dataclass(slots=True)
class IotSupplierResult:
    assessment: IotAssessment
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
    def normalized_iot(self) -> float | None:
        return self.assessment.normalized_iot


@dataclass(slots=True)
class IotRollupResult:
    level: str
    label: str
    scorecard_category: str
    country: str
    normalized_iot: float | None
    raw_values: RawIotValues
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
    invoice_on_time: float = 0.0
    total_po_lines: float = 0.0
    countries: set[str] = field(default_factory=set)
    scorecard_categories: Counter[str] = field(default_factory=Counter)


@dataclass(slots=True)
class IotReadModel:
    config: IotConfig
    filters: dict[str, tuple[str, ...]]
    source_row_count: int
    cohort_row_count: int
    assessments: list[IotAssessment]
    parent_results: list[IotRollupResult]
    parent_index: dict[str, IotRollupResult]
    _supplier_results: list[IotSupplierResult] | None = field(default=None, repr=False)
    _zone_results: list[IotRollupResult] | None = field(default=None, repr=False)
    _category_results: list[IotRollupResult] | None = field(default=None, repr=False)
    _lazy_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def supplier_results(self) -> list[IotSupplierResult]:
        if self._supplier_results is None:
            with self._lazy_lock:
                if self._supplier_results is None:
                    self._supplier_results = _score_suppliers(self.assessments, self.config)
        return self._supplier_results

    @property
    def zone_results(self) -> list[IotRollupResult]:
        if self._zone_results is None:
            with self._lazy_lock:
                if self._zone_results is None:
                    self._zone_results = _build_rollups(self.assessments, "zone", self.config)
        return self._zone_results

    @property
    def category_results(self) -> list[IotRollupResult]:
        if self._category_results is None:
            with self._lazy_lock:
                if self._category_results is None:
                    self._category_results = _build_rollups(self.assessments, "category", self.config)
        return self._category_results

    def level_rows(self, level: str) -> list[IotSupplierResult] | list[IotRollupResult]:
        if level == "supplier":
            return self.supplier_results
        if level == "zone":
            return self.zone_results
        if level == "category":
            return self.category_results
        return self.parent_results


def validate_iot_config(config: IotConfig) -> list[str]:
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
        and config.critical_floor >= config.target
    ):
        errors.append("Critical Floor must be less than Target.")
    if config.formula_mode not in IOT_FORMULA_MODES:
        errors.append("Formula Mode must be softStretch or strict.")
    return errors


def normalize_iot_filters(filters: dict[str, Iterable[str]] | None = None) -> dict[str, tuple[str, ...]]:
    source = filters or {}
    return {
        key: tuple(sorted({_text(value) for value in source.get(key, []) if _text(value)}))
        for key in ("categories", "scorecardCategories", "years", "months", "countries", "zones")
    }


def iot_filter_key(filters: dict[str, Iterable[str]] | None = None) -> tuple[tuple[str, ...], ...]:
    normalized = normalize_iot_filters(filters)
    return tuple(normalized[key] for key in ("categories", "scorecardCategories", "years", "months", "countries", "zones"))


def list_iot_filter_options(rows: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    values = {key: set() for key in ("categories", "scorecardCategories", "years", "months", "countries", "zones")}
    fields = {
        "categories": "category",
        "scorecardCategories": "scorecard_category",
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
        "scorecardCategories": sorted(values["scorecardCategories"]),
        "years": sorted(values["years"], key=_numeric_sort_key),
        "months": sorted(values["months"], key=_numeric_sort_key),
        "countries": sorted(values["countries"]),
        "zones": sorted(values["zones"]),
    }


def build_iot_read_model(
    rows: list[dict[str, Any]],
    config: IotConfig,
    filters: dict[str, Iterable[str]] | None = None,
) -> IotReadModel:
    errors = validate_iot_config(config)
    if errors:
        raise ValueError(" ".join(errors))
    normalized_filters = normalize_iot_filters(filters)
    cohort_rows = [row for row in rows if _passes_filters(row, normalized_filters)]
    assessments = [_assess_row(row, index + 1) for index, row in enumerate(cohort_rows)]
    parent_results = _build_rollups(assessments, "parent", config)
    return IotReadModel(
        config=config,
        filters=normalized_filters,
        source_row_count=len(rows),
        cohort_row_count=len(cohort_rows),
        assessments=assessments,
        parent_results=parent_results,
        parent_index={row.label: row for row in parent_results},
    )


def reconfigure_iot_read_model(model: IotReadModel, config: IotConfig) -> IotReadModel:
    errors = validate_iot_config(config)
    if errors:
        raise ValueError(" ".join(errors))
    parent_results = _build_rollups(model.assessments, "parent", config)
    return IotReadModel(
        config=config,
        filters=model.filters,
        source_row_count=model.source_row_count,
        cohort_row_count=model.cohort_row_count,
        assessments=model.assessments,
        parent_results=parent_results,
        parent_index={row.label: row for row in parent_results},
    )


def _scoped_level_rows(
    model: IotReadModel,
    level: str,
    parents: Iterable[str] | None = None,
) -> list[IotSupplierResult] | list[IotRollupResult]:
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


def query_iot_results(
    model: IotReadModel,
    *,
    level: str,
    search: str = "",
    parents: Iterable[str] | None = None,
    suppliers: Iterable[str] | None = None,
    sort: str = "rankDescending",
    order: str = "asc",
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    if level not in IOT_LEVELS:
        raise ValueError(f"Unsupported IOT result level: {level}")
    if sort not in IOT_SORT_FIELDS:
        raise ValueError(f"Unsupported IOT sort field: {sort}")
    if order not in {"asc", "desc"}:
        raise ValueError("IOT sort order must be asc or desc")

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
        "items": [serialize_iot_result(row, model.config) for row in rows[start:start + page_size]],
        "page": page,
        "page_size": page_size,
        "total_items": total_items,
        "total_pages": total_pages,
        "level": level,
        "sort": sort,
        "order": order,
    }


def summarize_iot_model(
    model: IotReadModel,
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

    valid = [row for row in rows if row.normalized_iot is not None]
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
        "average_iot_pct": round(
            sum(row.normalized_iot for row in valid if row.normalized_iot is not None) / len(valid) * 100,
            2,
        ) if valid else 0.0,
        "average_earned_score": round(sum(earned) / len(earned), 4) if earned else 0.0,
        "status_counts": status_counts,
        "config": model.config.as_api_dict(),
        "filters_applied": {key: list(values) for key, values in model.filters.items()},
    }


def search_iot_results(
    model: IotReadModel,
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
            "normalizedIot": row.normalized_iot,
            "earnedScore": row.earned,
            "scoreStatus": row.score_status,
        }
        for row in matches[:limit]
    ]


def serialize_iot_result(
    result: IotSupplierResult | IotRollupResult,
    config: IotConfig,
) -> dict[str, Any]:
    if isinstance(result, IotSupplierResult):
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
            "scorecardCategory": _scorecard_category(row),
            "year": _text(row.get("year")),
            "month": _text(row.get("month")),
            "invoiceOnTimeCount": assessment.raw_values.invoice_on_time,
            "totalPoLines": assessment.raw_values.total_po_lines,
            "normalizedIot": assessment.normalized_iot,
            "rankDescending": result.rank,
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
                assessment.normalized_iot,
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
        "scorecardCategory": result.scorecard_category,
        "invoiceOnTimeCount": result.raw_values.invoice_on_time,
        "totalPoLines": result.raw_values.total_po_lines,
        "normalizedIot": result.normalized_iot,
        "rankDescending": result.rank,
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
            result.normalized_iot,
            result.rank_note,
            result.percentile,
            result.attainment,
            result.earned,
            result.score_status,
            config,
            contributing_rows=result.contributing_rows,
        ),
    }


def iter_iot_csv(
    model: IotReadModel,
    *,
    parents: Iterable[str] | None = None,
    suppliers: Iterable[str] | None = None,
) -> Iterator[str]:
    supplier_set = {_text(value) for value in (suppliers or []) if _text(value)}
    results = list(_scoped_level_rows(model, "supplier", parents))
    if supplier_set:
        results = [row for row in results if row.label in supplier_set]
    results = _sort_results(results, "rankDescending", "asc")
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")

    def emit(values: list[Any]) -> str:
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow(values)
        return buffer.getvalue()

    config = model.config
    yield emit(["IOT KPI Config"])
    yield emit(["Max Score", config.max_score])
    yield emit(["Floor %", _format_percent(config.critical_floor, 2)])
    yield emit(["Target %", _format_percent(config.target, 2)])
    yield emit(["Rows", len(results)])
    yield emit([])
    yield emit(["Supplier Level"])
    yield emit([
        "Supplier", "Parent", "Zone", "Country", "Category", "SPM Category", "IOT %", "Rank",
        "Percentile", "Attainment", "Max", "Earned", "Score %", "Status",
    ])
    for result in results:
        row = serialize_iot_result(result, config)
        yield emit([
            row["supplier"], row["parentSupplier"], row["zone"], row["country"],
            row["category"], row["scorecardCategory"], _format_percent(row["normalizedIot"], 2),
            _format_rank(row["rankDescending"]), _format_percent(row["percentile"], 2),
            _format_number(row["attainmentFactor"], 4), _format_number(row["maxScore"], 2),
            _format_number(row["earnedScore"], 2), _format_percent(row["scorePercent"], 2),
            row["scoreStatus"],
        ])


def _assess_row(row: dict[str, Any], row_number: int) -> IotAssessment:
    applicable = _text(row.get("kpiApplicability") or "Applicable").casefold() != "not applicable"
    raw = RawIotValues(
        invoice_on_time=_to_number(row.get("invoiceOnTimeCount")) or 0.0,
        total_po_lines=_to_number(row.get("totalPoLines")) or 0.0,
    )
    normalized = raw.invoice_on_time / raw.total_po_lines if applicable and raw.total_po_lines > 0 else None
    return IotAssessment(
        row=row,
        row_number=row_number,
        is_applicable=applicable,
        normalized_iot=normalized,
        raw_values=raw,
        is_valid=applicable and normalized is not None,
    )


def _score_suppliers(assessments: list[IotAssessment], config: IotConfig) -> list[IotSupplierResult]:
    grouped_valid: dict[str, list[tuple[int, float]]] = {}
    for index, assessment in enumerate(assessments):
        if not assessment.is_valid or assessment.normalized_iot is None:
            continue
        grouped_valid.setdefault(_scorecard_category(assessment.row), []).append(
            (index, assessment.normalized_iot)
        )
    ranks: dict[int, tuple[float, float, str]] = {}
    for values in grouped_valid.values():
        ranks.update(_percentile_ranks(values, config.target))
    results: list[IotSupplierResult] = []
    for index, assessment in enumerate(assessments):
        if not assessment.is_applicable:
            results.append(IotSupplierResult(assessment, None, None, None, None, None, "Not Applicable"))
            continue
        if not assessment.is_valid or assessment.normalized_iot is None:
            results.append(IotSupplierResult(assessment, None, None, None, None, None, "Missing Data"))
            continue
        rank, percentile, note = ranks[index]
        attainment = _attainment(assessment.normalized_iot, config)
        earned = _earned(config, percentile, attainment)
        status = "Below critical floor" if assessment.normalized_iot <= config.critical_floor else "Valid score"
        results.append(IotSupplierResult(assessment, rank, percentile, note, attainment, earned, status))
    return results


def _build_rollups(
    assessments: list[IotAssessment],
    level: str,
    config: IotConfig,
) -> list[IotRollupResult]:
    groups: dict[str, _RollupAccumulator] = {}
    for assessment in assessments:
        if not assessment.is_applicable:
            continue
        label = _rollup_label(assessment.row, level)
        accumulator = groups.setdefault(label, _RollupAccumulator())
        accumulator.count += 1
        accumulator.scorecard_categories[_scorecard_category(assessment.row)] += 1
        accumulator.invoice_on_time += assessment.raw_values.invoice_on_time
        accumulator.total_po_lines += assessment.raw_values.total_po_lines
        country = _text(assessment.row.get("country"))
        if country:
            accumulator.countries.add(country)

    results: list[IotRollupResult] = []
    for label, accumulator in groups.items():
        normalized = (
            accumulator.invoice_on_time / accumulator.total_po_lines
            if accumulator.total_po_lines > 0 else None
        )
        results.append(IotRollupResult(
            level=level,
            label=label,
            scorecard_category=_collapse_scorecard_categories(accumulator.scorecard_categories),
            country=next(iter(accumulator.countries)) if len(accumulator.countries) == 1 else "Multiple",
            normalized_iot=normalized,
            raw_values=RawIotValues(accumulator.invoice_on_time, accumulator.total_po_lines),
            contributing_rows=accumulator.count,
        ))

    grouped_valid: dict[str, list[tuple[int, float]]] = {}
    for index, result in enumerate(results):
        if result.normalized_iot is None:
            continue
        grouped_valid.setdefault(result.scorecard_category, []).append((index, result.normalized_iot))
    ranks: dict[int, tuple[float, float, str]] = {}
    for values in grouped_valid.values():
        ranks.update(_percentile_ranks(values, config.target))
    for index, result in enumerate(results):
        if result.normalized_iot is None:
            continue
        rank, percentile, note = ranks[index]
        attainment = _attainment(result.normalized_iot, config)
        result.rank = rank
        result.percentile = percentile
        result.rank_note = note
        result.attainment = attainment
        result.earned = _earned(config, percentile, attainment)
        result.score_status = "Below critical floor" if result.normalized_iot <= config.critical_floor else "Valid score"
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
    distinct = {_iot_key(value) for _, value in values}
    if len(distinct) == 1:
        shared = values[0][1]
        percentile = 1.0 if shared >= target else 0.5
        average_rank = (count + 1) / 2
        return {index: (average_rank, percentile, "noVariance") for index, _ in values}

    sorted_rows = sorted(values, key=lambda item: item[1], reverse=True)
    ranks: dict[int, tuple[float, float, str]] = {}
    cursor = 0
    while cursor < count:
        current = _iot_key(sorted_rows[cursor][1])
        end = cursor + 1
        while end < count and _iot_key(sorted_rows[end][1]) == current:
            end += 1
        average_rank = (cursor + 1 + end) / 2
        percentile = (count - average_rank) / (count - 1)
        for position in range(cursor, end):
            ranks[sorted_rows[position][0]] = (average_rank, percentile, "standard")
        cursor = end
    return ranks


def _attainment(iot: float, config: IotConfig) -> float:
    if iot < config.critical_floor:
        return 0.0
    if iot >= config.target:
        return 1.0
    return max(0.0, min(1.0, (iot - config.critical_floor) / (config.target - config.critical_floor)))


def _earned(config: IotConfig, percentile: float, attainment: float) -> float:
    if config.formula_mode == "softStretch":
        return config.max_score * attainment * (0.7 + 0.3 * percentile)
    return config.max_score * percentile * attainment


def _explanation(
    iot: float | None,
    rank_note: str | None,
    percentile: float | None,
    attainment: float | None,
    earned: float | None,
    status: str,
    config: IotConfig,
    *,
    contributing_rows: int | None = None,
) -> str:
    if status == "Not Applicable":
        return "Not applicable: excluded from ranking and scoring."
    if iot is None or percentile is None or attainment is None or earned is None:
        return "Missing data: no valid PO lines available."
    messages: list[str] = []
    if rank_note == "single":
        messages.append("Single observation: percentile set to 100% by rule.")
    elif rank_note == "noVariance":
        messages.append("No variance: all results have the same IOT value.")
    if status == "Below critical floor":
        messages.append(
            f"Below critical floor: IOT {iot * 100:.2f}% <= floor {config.critical_floor * 100:.2f}%. Attainment = 0, earned score = 0."
        )
    else:
        messages.append(f"Valid score: IOT {iot * 100:.2f}%. Attainment = {attainment:.4f}.")
        if config.formula_mode == "softStretch":
            messages.append(
                f"Earned Score = {config.max_score:.2f} x {attainment:.4f} x (70% + 30% x {percentile * 100:.2f}%) = {earned:.2f}."
            )
        else:
            messages.append(
                f"Earned Score = {config.max_score:.2f} x {percentile * 100:.2f}% x {attainment:.4f} = {earned:.2f}."
            )
    if contributing_rows is not None:
        messages.append(f"Weighted rollup of {contributing_rows} applicable rows.")
    return " ".join(messages)


def _sort_results(rows: list[Any], sort: str, order: str) -> list[Any]:
    def value(row: Any) -> Any:
        if sort == "label":
            return row.label.casefold()
        if sort == "contributingRows" and isinstance(row, IotSupplierResult):
            return 1 if row.assessment.is_valid else 0
        attribute = {
            "normalizedIot": "normalized_iot",
            "rankDescending": "rank",
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
        "scorecardCategories": "scorecard_category",
        "years": "year",
        "countries": "country",
        "zones": "zone",
    }
    for key, field_name in fields.items():
        selected = filters[key]
        if selected and _text(row.get(field_name)) not in selected:
            return False
    months = filters["months"]
    if months and _normalize_month(_text(row.get("month"))) not in tuple(_normalize_month(value) for value in months):
        return False
    return True


def _rollup_label(row: dict[str, Any], level: str) -> str:
    if level == "parent":
        return _text(row.get("parentSupplier")) or "Unassigned parent"
    if level == "category":
        return _text(row.get("category")) or "Unassigned"
    return _text(row.get("zone")) or "Unassigned"


def _scorecard_category(row: dict[str, Any]) -> str:
    return _text(row.get("scorecard_category")) or "Unassigned scorecard category"


def _collapse_scorecard_categories(counts: Counter[str]) -> str:
    if not counts:
        return "Unassigned scorecard category"
    top_count = max(counts.values())
    return sorted(value for value, count in counts.items() if count == top_count)[0]


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
    return value.lstrip("0") or value


def _numeric_sort_key(value: str) -> tuple[int, str]:
    try:
        return int(value), value
    except ValueError:
        return 10_000, value


def _iot_key(value: float) -> str:
    return f"{value:.12f}"


def _format_percent(value: float | None, digits: int) -> str:
    return "-" if value is None else f"{value * 100:.{digits}f}%"


def _format_number(value: float | None, digits: int) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def _format_rank(value: float | None) -> str:
    if value is None:
        return "-"
    return str(int(value)) if value.is_integer() else f"{value:.2f}"
