import json

import pytest

import server


def _row(row_id, supplier, parent, po_value, invoice_value):
    return {
        "id": row_id,
        "supplier": supplier,
        "parentSupplier": parent,
        "zone": "EUR",
        "country": "Belgium",
        "category": "MALT",
        "kpiApplicability": "Applicable",
        "poValue": str(po_value),
        "invoiceValue": str(invoice_value),
        "year": "2026",
        "month": "05",
    }


@pytest.fixture(autouse=True)
def pdiv_cache():
    previous_rows = server._cache["price_divergence"]
    server._cache["price_divergence"] = [
        _row("1", "Alpha One", "Parent A", 100, 110),
        _row("2", "Alpha Two", "Parent A", 200, 190),
        _row("3", "Beta One", "Parent B", 100, 125),
    ]
    server._build_pdiv_saved_cache()
    yield
    server._cache["price_divergence"] = previous_rows
    with server._pdiv_read_model_lock:
        server._pdiv_context_cache.clear()
        server._pdiv_preview_cache.clear()


def _body(response):
    return json.loads(response.body)


def _results(level="supplier", preview_id=None):
    return _body(server.get_pdiv_results(
        level=level,
        categories=None,
        years="2026",
        months=None,
        countries=None,
        zones=None,
        parents="Parent A",
        suppliers=None,
        search="",
        sort="rankAscending",
        order="asc",
        page=1,
        page_size=100,
        preview_id=preview_id,
    ))


def test_results_summary_search_and_detail_are_parent_scoped():
    results = _results()
    summary = _body(server.get_pdiv_summary(
        level="supplier", parents="Parent A", suppliers=None, search="",
        categories=None, years="2026", months=None, countries=None, zones=None,
        preview_id=None,
    ))
    search = _body(server.search_pdiv_entities(
        q="alpha", level="supplier", parents="Parent A", categories=None,
        years="2026", months=None, countries=None, zones=None, limit=30,
        preview_id=None,
    ))
    detail = _body(server.get_pdiv_parent_detail(
        parent="Parent A", page=1, page_size=100, categories=None, years="2026",
        months=None, countries=None, zones=None, preview_id=None,
    ))

    assert results["total_items"] == 2
    assert {item["parentSupplier"] for item in results["items"]} == {"Parent A"}
    assert summary["result_count"] == 2
    assert {item["parentSupplier"] for item in search["items"]} == {"Parent A"}
    assert {item["parentSupplier"] for item in detail["suppliers"]["items"]} == {"Parent A"}


def test_zone_and_category_handlers_use_only_selected_parent():
    zone = _results("zone")
    category = _results("category")
    assert zone["items"][0]["normalizedDivergence"] == pytest.approx(20 / 300)
    assert zone["items"][0]["contributingRows"] == 2
    assert category["items"][0]["normalizedDivergence"] == pytest.approx(20 / 300)


def test_summary_handler_matches_supplier_selection_and_search():
    summary = _body(server.get_pdiv_summary(
        level="supplier", parents="Parent A", suppliers="Alpha One", search="alpha",
        categories=None, years="2026", months=None, countries=None, zones=None,
        preview_id=None,
    ))
    assert summary["result_count"] == 1
    assert summary["average_divergence_pct"] == 10


def test_strict_preview_is_temporary():
    saved = _results()
    preview = _body(server.create_pdiv_preview(server.PdivPreviewRequest(
        maxScore=5,
        criticalFloor=0.25,
        target=0.199,
        formulaMode="strict",
        filters={"years": ["2026"]},
    )))
    strict = _results(preview_id=preview["previewId"])
    saved_alpha = next(item for item in saved["items"] if item["supplier"] == "Alpha One")
    strict_alpha = next(item for item in strict["items"] if item["supplier"] == "Alpha One")

    assert saved_alpha["earnedScore"] == pytest.approx(4.25)
    assert strict_alpha["earnedScore"] == pytest.approx(2.5)
    assert server._saved_pdiv_config().formula_mode == "softStretch"
    assert _body(server.discard_pdiv_preview(preview["previewId"]))["status"] == "discarded"
