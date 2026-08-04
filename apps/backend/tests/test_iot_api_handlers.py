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
        "invoiceOnTimeCount": str(on_time),
        "totalPoLines": "100",
        "year": "2026",
        "month": "05",
    }


@pytest.fixture(autouse=True)
def iot_cache():
    previous_rows = server._cache["iot_kpi"]
    server._cache["iot_kpi"] = [
        _row("1", "Alpha One", "Parent A", 80),
        _row("2", "Alpha Two", "Parent A", 90),
        _row("3", "Beta One", "Parent B", 70),
    ]
    server._build_iot_saved_cache()
    yield
    server._cache["iot_kpi"] = previous_rows
    with server._iot_read_model_lock:
        server._iot_context_cache.clear()
        server._iot_preview_cache.clear()


def _body(response):
    return json.loads(response.body)


def _results(level="supplier", preview_id=None):
    return _body(server.get_iot_results(
        level=level,
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


def test_results_summary_search_and_detail_are_parent_scoped():
    results = _results()
    summary = _body(server.get_iot_summary(
        level="supplier",
        parents="Parent A",
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        preview_id=None,
    ))
    search = _body(server.search_iot_entities(
        q="alpha",
        level="supplier",
        parents="Parent A",
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        limit=30,
        preview_id=None,
    ))
    detail = _body(server.get_iot_parent_detail(
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

    assert results["total_items"] == 2
    assert {item["parentSupplier"] for item in results["items"]} == {"Parent A"}
    assert summary["result_count"] == 2
    assert {item["parentSupplier"] for item in search["items"]} == {"Parent A"}
    assert {item["parentSupplier"] for item in detail["suppliers"]["items"]} == {"Parent A"}


def test_zone_and_category_handlers_use_only_selected_parent():
    zone = _results("zone")
    category = _results("category")
    assert zone["items"][0]["normalizedIot"] == pytest.approx(0.85)
    assert zone["items"][0]["contributingRows"] == 2
    assert category["items"][0]["normalizedIot"] == pytest.approx(0.85)


def test_summary_handler_matches_supplier_selection_and_search():
    summary = _body(server.get_iot_summary(
        level="supplier",
        parents="Parent A",
        suppliers="Alpha One",
        search="alpha",
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        preview_id=None,
    ))

    assert summary["result_count"] == 1
    assert summary["average_iot_pct"] == 80


def test_strict_preview_is_temporary():
    saved = _results()
    preview = _body(server.create_iot_preview(server.IotPreviewRequest(
        maxScore=10,
        criticalFloor=0.7,
        target=0.85,
        formulaMode="strict",
        filters={"years": ["2026"]},
    )))
    strict = _results(preview_id=preview["previewId"])
    saved_alpha = next(item for item in saved["items"] if item["supplier"] == "Alpha One")
    strict_alpha = next(item for item in strict["items"] if item["supplier"] == "Alpha One")

    assert saved_alpha["earnedScore"] == pytest.approx(5.6666666667)
    assert strict_alpha["earnedScore"] == pytest.approx(3.3333333333)
    assert server._saved_iot_config().formula_mode == "softStretch"
    assert _body(server.discard_iot_preview(preview["previewId"]))["status"] == "discarded"
