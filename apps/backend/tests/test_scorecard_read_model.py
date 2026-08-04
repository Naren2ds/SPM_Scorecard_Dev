import csv
import io
import json
from collections import OrderedDict

import server
from scorecard_read_model import (
    build_scorecard_read_model,
    filter_leaderboard,
    iter_scorecard_csv,
    paginate_leaderboard,
    sort_leaderboard,
    summarize_scorecards,
)


def _scorecard_result():
    kpis = [
        {
            "id": "DOT",
            "name": "Delivery On Time",
            "pillar": "Service Level",
            "max_score": 10.0,
        }
    ]
    return {
        "cached_at": "2026-08-04T09:00:00",
        "pillar_weights": {"Service Level": 25.0},
        "total_expected_kpi_weight": 10.0,
        "kpis": kpis,
        "scorecards": [
            {
                "parentSupplier": "Alpha Brewing",
                "normalized_score": 90.0,
                "coverage_pct": 0.8,
                "coverage_adjusted_score": 72.0,
                "invoice_value": 100.0,
                "band": "Green",
                "pillars": [
                    {
                        "pillar": "Service Level",
                        "pillar_pct": 0.9,
                        "kpis": [{"id": "DOT", "earned": 9.0}],
                    }
                ],
            },
            {
                "parentSupplier": "Beta Packaging",
                "normalized_score": 60.0,
                "coverage_pct": 0.5,
                "coverage_adjusted_score": 30.0,
                "invoice_value": 200.0,
                "band": "Amber",
                "pillars": [
                    {
                        "pillar": "Service Level",
                        "pillar_pct": 0.6,
                        "kpis": [{"id": "DOT", "earned": 6.0}],
                    }
                ],
            },
            {
                "parentSupplier": "Gamma Brewing",
                "normalized_score": 40.0,
                "coverage_pct": 0.2,
                "coverage_adjusted_score": 8.0,
                "invoice_value": 50.0,
                "band": "Red",
                "pillars": [
                    {
                        "pillar": "Service Level",
                        "pillar_pct": 0.4,
                        "kpis": [{"id": "DOT", "earned": 4.0}],
                    }
                ],
            },
        ],
    }


def test_read_model_keeps_full_detail_only_in_parent_index():
    model = build_scorecard_read_model(_scorecard_result())

    compact = model["leaderboard"][0]
    assert compact["parentSupplier"] == "Alpha Brewing"
    assert compact["pillar_scores"] == {"Service Level": 0.9}
    assert "pillars" not in compact
    assert "kpis" not in compact
    assert model["parent_index"]["Alpha Brewing"]["pillars"][0]["kpis"][0]["id"] == "DOT"


def test_search_sort_and_pagination_use_compact_rows():
    rows = build_scorecard_read_model(_scorecard_result())["leaderboard"]

    matches = filter_leaderboard(rows, "BREW")
    assert [row["parentSupplier"] for row in matches] == [
        "Alpha Brewing",
        "Gamma Brewing",
    ]

    sorted_rows = sort_leaderboard(rows, "invoice_value", "desc")
    page, total_items, total_pages = paginate_leaderboard(sorted_rows, 1, 2)
    assert [row["parentSupplier"] for row in page] == [
        "Beta Packaging",
        "Alpha Brewing",
    ]
    assert total_items == 3
    assert total_pages == 2


def test_summary_uses_all_matching_rows_and_returns_percentage_coverage():
    rows = build_scorecard_read_model(_scorecard_result())["leaderboard"]
    summary = summarize_scorecards(
        rows,
        total_parent_count=29_359,
        cached_at="2026-08-04T09:00:00",
    )

    assert summary == {
        "total_parent_count": 29_359,
        "filtered_parent_count": 3,
        "average_normalized_score": 63.33,
        "average_coverage_pct": 50.0,
        "band_counts": {"Green": 1, "Amber": 1, "Red": 1},
        "cached_at": "2026-08-04T09:00:00",
    }


def test_csv_stream_preserves_detailed_kpi_and_pillar_values():
    result = _scorecard_result()
    content = "".join(iter_scorecard_csv(result, result["scorecards"][:1]))
    rows = list(csv.reader(io.StringIO(content)))

    assert rows[0] == [
        "Parent Supplier",
        "Normalized Score",
        "Coverage %",
        "Coverage-Adjusted",
        "Band",
        "Delivery On Time - Earned",
        "Delivery On Time - Max",
        "Service Level %",
        "Operational %",
        "Sustainability %",
        "Value Creation %",
    ]
    assert rows[1] == [
        "Alpha Brewing",
        "90.00",
        "80.00",
        "72.00",
        "Green",
        "9.000",
        "10.0",
        "90.00",
        "",
        "",
        "",
    ]


def test_scorecard_api_routes_use_lightweight_contracts(monkeypatch):
    result = _scorecard_result()
    model = build_scorecard_read_model(result)
    monkeypatch.setattr(server, "_scored_cache", result)
    monkeypatch.setattr(server, "_scored_read_model", model)
    monkeypatch.setattr(
        server,
        "_scorecard_filter_options",
        {"zones": ["EU"], "categories": ["Packaging"], "parents": []},
    )
    leaderboard = server.get_scorecard_leaderboard(
        zones=None,
        categories=None,
        search="",
        page=1,
        page_size=2,
        sort="invoice_value",
        order="desc",
    )
    leaderboard_body = json.loads(leaderboard.body)
    assert leaderboard_body["total_items"] == 3
    assert leaderboard_body["total_pages"] == 2
    assert len(leaderboard_body["items"]) == 2
    assert leaderboard_body["items"][0]["parentSupplier"] == "Beta Packaging"
    assert "pillars" not in leaderboard_body["items"][0]

    summary = server.get_scorecard_summary(search="brew")
    assert json.loads(summary.body)["filtered_parent_count"] == 2

    search = server.search_scorecard_parents(q="brew", limit=30)
    assert [item["parentSupplier"] for item in json.loads(search.body)["items"]] == [
        "Alpha Brewing",
        "Gamma Brewing",
    ]

    detail = server.get_scorecard_parent(name="Alpha Brewing")
    assert json.loads(detail.body)["scorecard"]["pillars"][0]["kpis"][0]["id"] == "DOT"

    filters = server.get_scorecard_filters()
    assert json.loads(filters.body)["parents"] == []

    export = server.export_scorecard(search="Alpha")
    assert "normalized_scorecard_" in export.headers["content-disposition"]


def test_filtered_context_is_computed_once_and_reused(monkeypatch):
    result = _scorecard_result()
    calls = []

    def compute_once(cache, **kwargs):
        calls.append(kwargs)
        return result

    monkeypatch.setattr(server, "compute_scorecard", compute_once)
    monkeypatch.setattr(server, "_scorecard_context_cache", OrderedDict())
    monkeypatch.setattr(server, "_scored_cache", {"cached_at": result["cached_at"]})

    first = server._get_scorecard_read_model("EU", "Packaging")
    second = server._get_scorecard_read_model("EU", "Packaging")

    assert first is second
    assert len(calls) == 1
    assert calls[0]["zones"] == ("EU",)
    assert calls[0]["categories"] == ("Packaging",)
    assert calls[0]["include_kpi_breakdown"] is True
