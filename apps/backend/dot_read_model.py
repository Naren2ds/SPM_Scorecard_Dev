"""Server-side DOT calculation and lightweight API read model."""

from __future__ import annotations

import csv
import io
import math
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator


DOT_LEVELS = {"parent", "supplier", "zone", "category"}
DOT_FORMULA_MODES = {"softStretch", "strict"}
DOT_SORT_FIELDS = {
    "label",
    "normalizedDot",
    "rankDescending",
    "percentile",
    "attainmentFactor",
    "earnedScore",
    "scorePercent",
    "contributingRows",
}


@dataclass(frozen=True, slots=True)
class DotConfig:
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
class RawDotValues:
    on_time: float
    total_delivered: float
    delayed: float
    early: float


@dataclass(slots=True)
class DotAssessment:
    row: dict[str, Any]
    row_number: int
    is_applicable: bool
    normalized_dot: float | None
    dot_raw_input: str
    raw_available: bool
    raw_values: RawDotValues | None
    is_valid: bool
    errors: tuple[str, ...]


@dataclass(slots=True)
class DotSupplierResult:
    assessment: DotAssessment
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
    def normalized_dot(self) -> float | None:
        return self.assessment.normalized_dot


@dataclass(slots=True)
class DotRollupResult:
    level: str
    label: str
    country: str
    is_applicable: bool
    normalized_dot: float | None
    dot_raw_input: str
    raw_values: RawDotValues | None
    source_status: str
    contributing_rows: int
    errors: tuple[str, ...]
    rank: float | None = None
    percentile: float | None = None
    rank_note: str | None = None
    attainment: float | None = None
    earned: float | None = None
    score_status: str = "Invalid DOT"


@dataclass(slots=True)
class _RollupAccumulator:
    total_rows: int = 0
    valid_rows: int = 0
    not_applicable_rows: int = 0
    invalid_rows: int = 0
    all_valid_have_raw: bool = True
    normalized_sum: float = 0.0
    on_time: float = 0.0
    total_delivered: float = 0.0
    delayed: float = 0.0
    early: float = 0.0
    countries: set[str] = field(default_factory=set)


@dataclass(slots=True)
class DotReadModel:
    config: DotConfig
    filters: dict[str, tuple[str, ...]]
    source_row_count: int
    cohort_row_count: int
    assessments: list[DotAssessment]
    parent_results: list[DotRollupResult]
    parent_index: dict[str, DotRollupResult]
    _supplier_results: list[DotSupplierResult] | None = field(default=None, repr=False)
    _zone_results: list[DotRollupResult] | None = field(default=None, repr=False)
    _category_results: list[DotRollupResult] | None = field(default=None, repr=False)
    _lazy_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def supplier_results(self) -> list[DotSupplierResult]:
        if self._supplier_results is None:
            with self._lazy_lock:
                if self._supplier_results is None:
                    self._supplier_results = _score_suppliers(self.assessments, self.config)
        return self._supplier_results

    @property
    def zone_results(self) -> list[DotRollupResult]:
        if self._zone_results is None:
            with self._lazy_lock:
                if self._zone_results is None:
                    self._zone_results = _build_rollups(self.assessments, "zone", self.config)
        return self._zone_results

    @property
    def category_results(self) -> list[DotRollupResult]:
        if self._category_results is None:
            with self._lazy_lock:
                if self._category_results is None:
                    self._category_results = _build_rollups(self.assessments, "category", self.config)
        return self._category_results

    def level_rows(self, level: str) -> list[DotSupplierResult] | list[DotRollupResult]:
        if level == "supplier":
            return self.supplier_results
        if level == "zone":
            return self.zone_results
        if level == "category":
            return self.category_results
        return self.parent_results


def validate_dot_config(config: DotConfig) -> list[str]:
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
    if config.formula_mode not in DOT_FORMULA_MODES:
        errors.append("Formula Mode must be softStretch or strict.")
    return errors


def normalize_dot_filters(filters: dict[str, Iterable[str]] | None = None) -> dict[str, tuple[str, ...]]:
    source = filters or {}
    return {
        key: tuple(sorted({_text(value) for value in source.get(key, []) if _text(value)}))
        for key in ("categories", "years", "months", "countries", "zones")
    }


def dot_filter_key(filters: dict[str, Iterable[str]] | None = None) -> tuple[tuple[str, ...], ...]:
    normalized = normalize_dot_filters(filters)
    return tuple(normalized[key] for key in ("categories", "years", "months", "countries", "zones"))


def list_dot_filter_options(rows: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    values = {
        "categories": set(),
        "years": set(),
        "months": set(),
        "countries": set(),
        "zones": set(),
    }
    field_by_key = {
        "categories": "category",
        "years": "year",
        "months": "month",
        "countries": "country",
        "zones": "zone",
    }
    for row in rows:
        for key, field_name in field_by_key.items():
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


def build_dot_read_model(
    rows: list[dict[str, Any]],
    config: DotConfig,
    filters: dict[str, Iterable[str]] | None = None,
) -> DotReadModel:
    errors = validate_dot_config(config)
    if errors:
        raise ValueError(" ".join(errors))

    normalized_filters = normalize_dot_filters(filters)
    cohort_rows = [row for row in rows if _passes_filters(row, normalized_filters)]
    assessments = [_assess_row(row, index + 1) for index, row in enumerate(cohort_rows)]
    parent_results = _build_rollups(assessments, "parent", config)
    return DotReadModel(
        config=config,
        filters=normalized_filters,
        source_row_count=len(rows),
        cohort_row_count=len(cohort_rows),
        assessments=assessments,
        parent_results=parent_results,
        parent_index={row.label: row for row in parent_results},
    )


def reconfigure_dot_read_model(model: DotReadModel, config: DotConfig) -> DotReadModel:
    """Create a scoring preview while sharing the already validated cohort."""
    errors = validate_dot_config(config)
    if errors:
        raise ValueError(" ".join(errors))
    parent_results = _build_rollups(model.assessments, "parent", config)
    return DotReadModel(
        config=config,
        filters=model.filters,
        source_row_count=model.source_row_count,
        cohort_row_count=model.cohort_row_count,
        assessments=model.assessments,
        parent_results=parent_results,
        parent_index={row.label: row for row in parent_results},
    )


def _scoped_level_rows(
    model: DotReadModel,
    level: str,
    parents: Iterable[str] | None = None,
) -> list[DotSupplierResult] | list[DotRollupResult]:
    """Apply the selected parent as a drilldown scope for every result level."""
    parent_set = {_text(value) for value in (parents or []) if _text(value)}
    if not parent_set:
        return model.level_rows(level)
    if level == "parent":
        return [row for row in model.parent_results if row.label in parent_set]
    if level == "supplier":
        return [
            row
            for row in model.supplier_results
            if _text(row.assessment.row.get("parentSupplier")) in parent_set
        ]

    assessments = [
        row
        for row in model.assessments
        if _text(row.row.get("parentSupplier")) in parent_set
    ]
    return _build_rollups(assessments, level, model.config)


def query_dot_results(
    model: DotReadModel,
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
    if level not in DOT_LEVELS:
        raise ValueError(f"Unsupported DOT result level: {level}")
    if sort not in DOT_SORT_FIELDS:
        raise ValueError(f"Unsupported DOT sort field: {sort}")
    if order not in {"asc", "desc"}:
        raise ValueError("DOT sort order must be asc or desc")

    supplier_set = {_text(value) for value in (suppliers or []) if _text(value)}
    query = search.strip().casefold()
    rows = list(_scoped_level_rows(model, level, parents))

    if level == "supplier":
        if supplier_set:
            rows = [row for row in rows if _text(row.assessment.row.get("supplier")) in supplier_set]
        if query:
            rows = [
                row
                for row in rows
                if query in row.label.casefold()
                or query in _text(row.assessment.row.get("parentSupplier")).casefold()
            ]
    elif level == "parent":
        if query:
            rows = [row for row in rows if query in row.label.casefold()]
    elif query:
        rows = [row for row in rows if query in row.label.casefold()]

    rows = _sort_results(rows, sort, order)
    total_items = len(rows)
    total_pages = math.ceil(total_items / page_size) if total_items else 0
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]
    return {
        "items": [serialize_dot_result(row, model.config) for row in page_rows],
        "page": page,
        "page_size": page_size,
        "total_items": total_items,
        "total_pages": total_pages,
        "level": level,
        "sort": sort,
        "order": order,
    }


def summarize_dot_model(
    model: DotReadModel,
    level: str = "parent",
    parents: Iterable[str] | None = None,
) -> dict[str, Any]:
    rows = _scoped_level_rows(model, level, parents)
    valid = [row for row in rows if row.normalized_dot is not None]
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
        "average_dot_pct": round(
            (sum(row.normalized_dot for row in valid if row.normalized_dot is not None) / len(valid)) * 100,
            2,
        ) if valid else 0.0,
        "average_earned_score": round(sum(earned) / len(earned), 4) if earned else 0.0,
        "status_counts": status_counts,
        "config": model.config.as_api_dict(),
        "filters_applied": {key: list(values) for key, values in model.filters.items()},
    }


def search_dot_results(
    model: DotReadModel,
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
        parent_set = {_text(value) for value in (parents or []) if _text(value)}
        names: dict[str, str] = {}
        for result in model.supplier_results:
            parent = _text(result.assessment.row.get("parentSupplier"))
            if parent_set and parent not in parent_set:
                continue
            supplier = result.label
            if text in supplier.casefold():
                names.setdefault(supplier, parent)
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
            "normalizedDot": row.normalized_dot,
            "earnedScore": row.earned,
            "scoreStatus": row.score_status,
        }
        for row in matches[:limit]
    ]


def serialize_dot_result(
    result: DotSupplierResult | DotRollupResult,
    config: DotConfig,
) -> dict[str, Any]:
    if isinstance(result, DotSupplierResult):
        assessment = result.assessment
        row = assessment.row
        raw = assessment.raw_values
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
            "dotRawInput": assessment.dot_raw_input,
            "onTimePoLines": raw.on_time if raw else None,
            "totalDeliveredPoLines": raw.total_delivered if raw else None,
            "x1DelayedOver30Days": raw.delayed if raw else None,
            "x2EarlyOver30Days": raw.early if raw else None,
            "normalizedDot": assessment.normalized_dot,
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
            "explanation": _score_explanation(
                assessment.normalized_dot,
                result.rank_note,
                result.percentile,
                result.attainment,
                result.earned,
                result.score_status,
                config,
            ) if assessment.is_applicable and assessment.is_valid else (
                "Not applicable: DOT KPI is excluded from ranking, rollups, and earned score for this supplier."
                if not assessment.is_applicable
                else " ".join(assessment.errors)
            ),
        }

    raw = result.raw_values
    source_message = _rollup_source_message(result.source_status)
    explanation = (
        "Not applicable: every supplier in this rollup is excluded from DOT scoring."
        if not result.is_applicable
        else " ".join(result.errors)
        if result.errors
        else f"{_score_explanation(result.normalized_dot, result.rank_note, result.percentile, result.attainment, result.earned, result.score_status, config)} {source_message}".strip()
    )
    return {
        "id": f"{result.level}-{result.label}",
        "level": result.level,
        "label": result.label,
        "parentSupplier": result.label if result.level == "parent" else "All parents",
        "zone": result.label if result.level == "zone" else "All zones",
        "country": result.country,
        "dotRawInput": result.dot_raw_input,
        "onTimePoLines": raw.on_time if raw else None,
        "totalDeliveredPoLines": raw.total_delivered if raw else None,
        "x1DelayedOver30Days": raw.delayed if raw else None,
        "x2EarlyOver30Days": raw.early if raw else None,
        "normalizedDot": result.normalized_dot,
        "rankDescending": result.rank,
        "percentile": result.percentile,
        "criticalFloor": config.critical_floor,
        "target": config.target,
        "attainmentFactor": result.attainment,
        "maxScore": config.max_score,
        "earnedScore": result.earned,
        "scorePercent": result.earned / config.max_score if result.earned is not None else None,
        "scoreStatus": result.score_status,
        "sourceStatus": result.source_status,
        "contributingRows": result.contributing_rows,
        "explanation": explanation,
    }


def iter_dot_csv(
    model: DotReadModel,
    *,
    parents: Iterable[str] | None = None,
    suppliers: Iterable[str] | None = None,
) -> Iterator[str]:
    parent_set = {_text(value) for value in (parents or []) if _text(value)}
    supplier_set = {_text(value) for value in (suppliers or []) if _text(value)}
    results = [
        result
        for result in model.supplier_results
        if (
            not parent_set
            or _text(result.assessment.row.get("parentSupplier")) in parent_set
        )
        and (not supplier_set or result.label in supplier_set)
    ]
    results = _sort_results(results, "rankDescending", "asc")
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")

    def emit(values: list[Any]) -> str:
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow(values)
        return buffer.getvalue()

    config = model.config
    yield emit(["DOT Config"])
    yield emit(["Max Score", config.max_score])
    yield emit(["Floor %", _format_percent(config.critical_floor, 2)])
    yield emit(["Target %", _format_percent(config.target, 2)])
    yield emit(["Rows", len(results)])
    yield emit([])
    yield emit(["Supplier Level"])
    yield emit([
        "Supplier",
        "Parent",
        "Zone",
        "Country",
        "Category",
        "DOT %",
        "Rank",
        "Percentile",
        "Attainment",
        "Max",
        "Earned",
        "Score %",
        "Status",
    ])
    for result in results:
        row = serialize_dot_result(result, config)
        yield emit([
            row["supplier"],
            row["parentSupplier"],
            row["zone"],
            row["country"],
            row["category"],
            _format_percent(row["normalizedDot"], 2),
            _format_rank(row["rankDescending"]),
            _format_percent(row["percentile"], 2),
            _format_number(row["attainmentFactor"], 4),
            _format_number(row["maxScore"], 2),
            _format_number(row["earnedScore"], 2),
            _format_percent(row["scorePercent"], 2),
            row["scoreStatus"],
        ])


def _assess_row(row: dict[str, Any], row_number: int) -> DotAssessment:
    applicable = _text(row.get("kpiApplicability") or "Applicable").casefold() != "not applicable"
    if not applicable:
        return DotAssessment(row, row_number, False, None, "Not applicable", False, None, False, ())

    raw_fields = (
        row.get("onTimePoLines"),
        row.get("totalDeliveredPoLines"),
        row.get("x1DelayedOver30Days"),
        row.get("x2EarlyOver30Days"),
    )
    raw_touched = any(_text(value) for value in raw_fields)
    if raw_touched:
        errors: list[str] = []
        on_time = _to_number(row.get("onTimePoLines"))
        total = _to_number(row.get("totalDeliveredPoLines"))
        delayed = _to_number(row.get("x1DelayedOver30Days")) if _text(row.get("x1DelayedOver30Days")) else 0.0
        early = _to_number(row.get("x2EarlyOver30Days")) if _text(row.get("x2EarlyOver30Days")) else 0.0
        if on_time is None:
            errors.append("Raw DOT requires On-Time PO Lines.")
        if total is None:
            errors.append("Raw DOT requires Total Delivered PO Lines.")
        if delayed is None:
            errors.append("X1 Delayed Over 30 Days must be numeric.")
        if early is None:
            errors.append("X2 Early Over 30 Days must be numeric.")
        raw = RawDotValues(on_time, total, delayed, early) if None not in (on_time, total, delayed, early) else None
        if raw:
            for label, value in (
                ("onTimePoLines", raw.on_time),
                ("totalDeliveredPoLines", raw.total_delivered),
                ("x1DelayedOver30Days", raw.delayed),
                ("x2EarlyOver30Days", raw.early),
            ):
                if value < 0:
                    errors.append(f"{label} cannot be negative.")
        raw_input = _raw_formula(raw) if raw else "Raw fields incomplete"
        normalized = None
        if raw and not errors:
            denominator = raw.total_delivered + 0.99 * raw.delayed + 0.10 * raw.early
            if denominator <= 0:
                errors.append("Raw DOT denominator must be greater than 0.")
            else:
                normalized = raw.on_time / denominator
                if normalized < 0 or normalized > 1:
                    errors.append("Invalid DOT: value is outside 0-100% range.")
                    normalized = None
        return DotAssessment(
            row,
            row_number,
            True,
            normalized,
            raw_input,
            True,
            raw,
            not errors and normalized is not None,
            tuple(errors),
        )

    parsed = _to_number(row.get("dotPercent"))
    errors = []
    normalized = parsed
    if parsed is None:
        errors.append("DOT is required when raw fields are not available.")
    elif 1 < parsed <= 100:
        normalized = parsed / 100
    if normalized is not None and not 0 <= normalized <= 1:
        errors.append("Invalid DOT: value is outside 0-100% range.")
        normalized = None
    return DotAssessment(
        row,
        row_number,
        True,
        normalized,
        _text(row.get("dotPercent")),
        False,
        None,
        not errors and normalized is not None,
        tuple(errors),
    )


def _score_suppliers(assessments: list[DotAssessment], config: DotConfig) -> list[DotSupplierResult]:
    valid = [(index, row.normalized_dot) for index, row in enumerate(assessments) if row.is_applicable and row.is_valid and row.normalized_dot is not None]
    ranks = _percentile_ranks(valid, config.target)
    results: list[DotSupplierResult] = []
    for index, assessment in enumerate(assessments):
        if not assessment.is_applicable:
            results.append(DotSupplierResult(assessment, None, None, None, None, None, "Not applicable"))
            continue
        if not assessment.is_valid or assessment.normalized_dot is None:
            results.append(DotSupplierResult(assessment, None, None, None, None, None, "Invalid DOT"))
            continue
        rank, percentile, note = ranks[index]
        attainment = _attainment(assessment.normalized_dot, config)
        earned = _earned(config, percentile, attainment)
        status = _score_status(assessment.normalized_dot, attainment, note, config)
        results.append(DotSupplierResult(assessment, rank, percentile, note, attainment, earned, status))
    return results


def _build_rollups(
    assessments: list[DotAssessment],
    level: str,
    config: DotConfig,
) -> list[DotRollupResult]:
    groups: dict[str, _RollupAccumulator] = {}
    for assessment in assessments:
        label = _rollup_label(assessment.row, level)
        accumulator = groups.setdefault(label, _RollupAccumulator())
        accumulator.total_rows += 1
        country = _text(assessment.row.get("country"))
        if country:
            accumulator.countries.add(country)
        if not assessment.is_applicable:
            accumulator.not_applicable_rows += 1
        elif assessment.is_valid and assessment.normalized_dot is not None:
            accumulator.valid_rows += 1
            accumulator.normalized_sum += assessment.normalized_dot
            if assessment.raw_available and assessment.raw_values:
                raw = assessment.raw_values
                accumulator.on_time += raw.on_time
                accumulator.total_delivered += raw.total_delivered
                accumulator.delayed += raw.delayed
                accumulator.early += raw.early
            else:
                accumulator.all_valid_have_raw = False
        else:
            accumulator.invalid_rows += 1

    results: list[DotRollupResult] = []
    for label, accumulator in groups.items():
        is_applicable = True
        errors: list[str] = []
        raw_values = None
        normalized = None
        raw_input = ""
        source_status = ""
        if accumulator.valid_rows == 0 and accumulator.not_applicable_rows == accumulator.total_rows:
            is_applicable = False
            source_status = "Not applicable"
            raw_input = "Not applicable"
        elif accumulator.valid_rows == 0:
            errors.append("No valid supplier DOT rows available for this rollup.")
            source_status = "Invalid"
            raw_input = "No valid input"
        elif accumulator.all_valid_have_raw:
            raw_values = RawDotValues(
                accumulator.on_time,
                accumulator.total_delivered,
                accumulator.delayed,
                accumulator.early,
            )
            denominator = raw_values.total_delivered + 0.99 * raw_values.delayed + 0.10 * raw_values.early
            normalized = raw_values.on_time / denominator if denominator > 0 else None
            raw_input = _raw_formula(raw_values)
            source_status = "Weighted raw aggregation"
            if denominator <= 0:
                errors.append("Raw DOT denominator must be greater than 0.")
            elif normalized is None or not 0 <= normalized <= 1:
                errors.append("Invalid DOT: value is outside 0-100% range.")
                normalized = None
        else:
            normalized = accumulator.normalized_sum / accumulator.valid_rows
            raw_input = f"Average of {accumulator.valid_rows} supplier DOT values"
            source_status = "Proxy only - simple average; raw numerator/denominator not available."

        if accumulator.invalid_rows:
            suffix = "" if accumulator.invalid_rows == 1 else "s"
            source_status = f"{source_status} {accumulator.invalid_rows} invalid supplier row{suffix} excluded.".strip()
        if accumulator.not_applicable_rows and is_applicable:
            suffix = "" if accumulator.not_applicable_rows == 1 else "s"
            source_status = f"{source_status} {accumulator.not_applicable_rows} not-applicable supplier row{suffix} excluded.".strip()
        country = "Unassigned" if not accumulator.countries else next(iter(accumulator.countries)) if len(accumulator.countries) == 1 else "Multiple"
        results.append(DotRollupResult(
            level=level,
            label=label,
            country=country,
            is_applicable=is_applicable,
            normalized_dot=None if errors else normalized,
            dot_raw_input=raw_input,
            raw_values=raw_values,
            source_status=source_status,
            contributing_rows=accumulator.valid_rows,
            errors=tuple(errors),
        ))

    valid = [(index, row.normalized_dot) for index, row in enumerate(results) if not row.errors and row.normalized_dot is not None]
    ranks = _percentile_ranks(valid, config.target)
    for index, result in enumerate(results):
        if not result.is_applicable:
            result.score_status = "Not applicable"
        elif result.errors or result.normalized_dot is None:
            result.score_status = "Invalid DOT"
        else:
            rank, percentile, note = ranks[index]
            result.rank = rank
            result.percentile = percentile
            result.rank_note = note
            result.attainment = _attainment(result.normalized_dot, config)
            result.earned = _earned(config, percentile, result.attainment)
            result.score_status = _score_status(result.normalized_dot, result.attainment, note, config)
    return results


def _percentile_ranks(
    indexed_values: list[tuple[int, float | None]],
    target: float,
) -> dict[int, tuple[float, float, str]]:
    values = [(index, float(value)) for index, value in indexed_values if value is not None and math.isfinite(value)]
    count = len(values)
    if not count:
        return {}
    if count == 1:
        return {values[0][0]: (1.0, 1.0, "single")}
    keys = {_dot_key(value) for _, value in values}
    if len(keys) == 1:
        percentile = 1.0 if values[0][1] >= target else 0.5
        average_rank = (count + 1) / 2
        return {index: (average_rank, percentile, "noVariance") for index, _ in values}

    sorted_values = sorted(values, key=lambda item: item[1], reverse=True)
    result: dict[int, tuple[float, float, str]] = {}
    cursor = 0
    while cursor < count:
        key = _dot_key(sorted_values[cursor][1])
        end = cursor + 1
        while end < count and _dot_key(sorted_values[end][1]) == key:
            end += 1
        average_rank = ((cursor + 1) + end) / 2
        percentile = (count - average_rank) / (count - 1)
        for index in range(cursor, end):
            result[sorted_values[index][0]] = (average_rank, percentile, "standard")
        cursor = end
    return result


def _attainment(dot: float, config: DotConfig) -> float:
    if dot < config.critical_floor:
        return 0.0
    if dot >= config.target:
        return 1.0
    return min(1.0, max(0.0, (dot - config.critical_floor) / (config.target - config.critical_floor)))


def _earned(config: DotConfig, percentile: float, attainment: float) -> float:
    if config.formula_mode == "softStretch":
        return config.max_score * attainment * (0.7 + 0.3 * percentile)
    return config.max_score * percentile * attainment


def _score_status(dot: float, attainment: float, rank_note: str, config: DotConfig) -> str:
    if dot == 0:
        return "Zero DOT"
    if dot <= config.critical_floor or attainment == 0:
        return "Below critical floor"
    if rank_note == "single":
        return "Single observation"
    if rank_note == "noVariance":
        return "No variance"
    return "Valid score"


def _score_explanation(
    dot: float | None,
    rank_note: str | None,
    percentile: float | None,
    attainment: float | None,
    earned: float | None,
    status: str,
    config: DotConfig,
) -> str:
    if dot is None or percentile is None or attainment is None or earned is None:
        return "Unable to calculate percentile for this result."
    messages: list[str] = []
    if rank_note == "single":
        messages.append("Single observation: percentile set to 100% by rule.")
    if rank_note == "noVariance":
        messages.append("No variance: all results have the same DOT value.")
    if status == "Zero DOT":
        messages.append("Zero DOT: result is applicable, included in scoring, and earned score is 0.")
    elif status == "Below critical floor":
        messages.append(
            f"Below critical floor: DOT {dot * 100:.2f}% <= floor {config.critical_floor * 100:.2f}%. Attainment = 0, earned score = 0."
        )
        return " ".join(messages)
    elif dot >= config.target:
        messages.append(
            f"Valid score: DOT {dot * 100:.2f}% is above target {config.target * 100:.2f}%. Attainment = 1.0000."
        )
    else:
        messages.append(
            f"Valid score: DOT {dot * 100:.2f}% is between floor {config.critical_floor * 100:.2f}% and target {config.target * 100:.2f}%. Attainment = {attainment:.4f}."
        )
    if config.formula_mode == "softStretch" and attainment > 0:
        messages.append("Softer stretch: 70% of attainment score is protected, 30% is differentiated by percentile.")
        messages.append(
            f"Earned Score = {config.max_score:.2f} x {attainment:.4f} x (70% + 30% x {percentile * 100:.2f}%) = {earned:.2f}."
        )
    else:
        messages.append(
            f"Earned Score = {config.max_score:.2f} x {percentile * 100:.2f}% x {attainment:.4f} = {earned:.2f}."
        )
    return " ".join(messages)


def _rollup_source_message(source_status: str) -> str:
    if not source_status.startswith("Weighted raw aggregation"):
        return source_status
    suffix = source_status.replace("Weighted raw aggregation", "", 1).strip()
    base = "Rollup DOT uses weighted raw aggregation: sum On-Time PO Lines / (sum Total Delivered PO Lines + 0.99 x sum X1 + 0.10 x sum X2)."
    return f"{base} {suffix}".strip()


def _sort_results(rows: list[Any], sort: str, order: str) -> list[Any]:
    def value(row: Any) -> Any:
        if sort == "label":
            return row.label.casefold()
        attribute = {
            "normalizedDot": "normalized_dot",
            "rankDescending": "rank",
            "percentile": "percentile",
            "attainmentFactor": "attainment",
            "earnedScore": "earned",
            "scorePercent": "earned",
            "contributingRows": "contributing_rows",
        }[sort]
        if sort == "contributingRows" and isinstance(row, DotSupplierResult):
            return 1 if row.assessment.is_valid else 0
        result = getattr(row, attribute, None)
        if sort == "scorePercent" and result is not None:
            return result
        return result

    present = [row for row in rows if value(row) is not None]
    missing = [row for row in rows if value(row) is None]
    present.sort(key=lambda row: row.label.casefold())
    present.sort(key=value, reverse=order == "desc")
    return present + missing


def _passes_filters(row: dict[str, Any], filters: dict[str, tuple[str, ...]]) -> bool:
    fields = {
        "categories": "category",
        "years": "year",
        "countries": "country",
        "zones": "zone",
    }
    for key, field_name in fields.items():
        selected = filters[key]
        if selected and _text(row.get(field_name)) not in selected:
            return False
    months = filters["months"]
    if months and _normalize_month(_text(row.get("month"))) not in tuple(
        _normalize_month(value) for value in months
    ):
        return False
    return True


def _rollup_label(row: dict[str, Any], level: str) -> str:
    if level == "parent":
        return _text(row.get("parentSupplier")) or "Unassigned parent"
    if level == "category":
        return _text(row.get("category")) or "Unassigned category"
    return _text(row.get("zone")) or "Unassigned zone"


def _raw_formula(raw: RawDotValues) -> str:
    return f"{raw.on_time} / ({raw.total_delivered} + 0.99 x {raw.delayed} + 0.10 x {raw.early})"


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


def _dot_key(value: float) -> str:
    return f"{value:.12f}"


def _format_percent(value: float | None, digits: int) -> str:
    return "-" if value is None or not math.isfinite(value) else f"{value * 100:.{digits}f}%"


def _format_number(value: float | None, digits: int) -> str:
    return "-" if value is None or not math.isfinite(value) else f"{value:.{digits}f}"


def _format_rank(value: float | None) -> str:
    return "-" if value is None or not math.isfinite(value) else str(math.floor(value))
