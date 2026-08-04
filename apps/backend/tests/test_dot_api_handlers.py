import json

import pytest

import server


def _row(row_id, supplier, parent, on_time):
    return {
        "id": row_id,
        "supplier": supplier,
        "parentSupplier": parent,
        "zone": "EUR",
        "country": "Belgium",
        "category": "MALT",
        "kpiApplicability": "Applicable",
        "onTimePoLines": str(on_time),
        "totalDeliveredPoLines": "100",
        "x1DelayedOver30Days": "0",
        "x2EarlyOver30Days": "0",
        "year": "2026",
        "month": "05",
    }


@pytest.fixture(autouse=True)
def dot_cache():
    previous_rows = server._cache["dot_kpi"]
    server._cache["dot_kpi"] = [
        _row("1", "Alpha One", "Parent A", 80),
        _row("2", "Alpha Two", "Parent A", 90),
        _row("3", "Beta One", "Parent B", 70),
    ]
    server._build_dot_saved_cache()
    yield
    server._cache["dot_kpi"] = previous_rows
    with server._dot_read_model_lock:
        server._dot_context_cache.clear()
        server._dot_preview_cache.clear()


def _body(response):
    return json.loads(response.body)


def _supplier_results(preview_id=None):
    return _body(server.get_dot_results(
        level="supplier",
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        parents="Parent A",
        suppliers=None,
        search="",
        sort="rankDescending",
        order="asc",
        page=1,
        page_size=100,
        preview_id=preview_id,
    ))


def test_results_and_bounded_search_keep_full_cohort_rank():
    results = _supplier_results()
    summary = _body(server.get_dot_summary(
        level="supplier",
        parents="Parent A",
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        preview_id=None,
    ))
    alpha_one = next(item for item in results["items"] if item["supplier"] == "Alpha One")
    search = _body(server.search_dot_entities(
        q="parent a",
        level="parent",
        parents=None,
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        limit=30,
        preview_id=None,
    ))

    assert results["total_items"] == 2
    assert summary["result_count"] == 2
    assert summary["valid_result_count"] == 2
    assert alpha_one["rankDescending"] == 2
    assert alpha_one["percentile"] == pytest.approx(0.5)
    assert search["items"][0]["label"] == "Parent A"


def test_strict_preview_is_temporary_and_does_not_change_saved_formula():
    saved = _supplier_results()
    preview = _body(server.create_dot_preview(server.DotPreviewRequest(
        maxScore=10,
        criticalFloor=0.7,
        target=0.85,
        formulaMode="strict",
        filters={"years": ["2026"]},
    )))
    strict = _supplier_results(preview["previewId"])

    saved_alpha = next(item for item in saved["items"] if item["supplier"] == "Alpha One")
    strict_alpha = next(item for item in strict["items"] if item["supplier"] == "Alpha One")
    assert saved_alpha["earnedScore"] == pytest.approx(5.6666666667)
    assert strict_alpha["earnedScore"] == pytest.approx(3.3333333333)
    assert server._saved_dot_config().formula_mode == "softStretch"
    assert _body(server.discard_dot_preview(preview["previewId"]))["status"] == "discarded"


def test_zone_category_and_detail_handlers_are_scoped_to_selected_parent():
    common = {
        "categories": None,
        "years": "2026",
        "months": None,
        "countries": None,
        "zones": None,
        "parents": "Parent A",
        "suppliers": None,
        "search": "",
        "sort": "rankDescending",
        "order": "asc",
        "page": 1,
        "page_size": 100,
        "preview_id": None,
    }
    zone = _body(server.get_dot_results(level="zone", **common))
    category = _body(server.get_dot_results(level="category", **common))
    detail = _body(server.get_dot_parent_detail(
        parent="Parent A",
        page=1,
        page_size=100,
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        preview_id=None,
    ))

    assert zone["total_items"] == 1
    assert zone["items"][0]["normalizedDot"] == pytest.approx(0.85)
    assert category["total_items"] == 1
    assert category["items"][0]["normalizedDot"] == pytest.approx(0.85)
    assert detail["parent"]["label"] == "Parent A"
    assert {item["parentSupplier"] for item in detail["suppliers"]["items"]} == {"Parent A"}
