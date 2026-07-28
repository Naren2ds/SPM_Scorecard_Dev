"""
FastAPI server for SPM Scorecard.
- Serves cached KPI data instantly
- Refreshes from Databricks in background on demand
"""

import threading
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ─── Sandbox mode: serve from pre-built CSV files, no Databricks ────────────
DATA_DIR         = Path(__file__).resolve().parent / "data"
DOT_OUTPUT_PATH  = DATA_DIR / "dot_kpi.csv"
IOT_OUTPUT_PATH  = DATA_DIR / "iot_kpi.csv"
SA_OUTPUT_PATH   = DATA_DIR / "supplier_assessment.csv"
SC_OUTPUT_PATH   = DATA_DIR / "supplier_compliance.csv"
SM_OUTPUT_PATH   = DATA_DIR / "supplier_maturity.csv"
CO2_OUTPUT_PATH  = DATA_DIR / "co2_emission.csv"
ECL_OUTPUT_PATH  = DATA_DIR / "eclipse.csv"
IC_OUTPUT_PATH   = DATA_DIR / "invoice_conformity.csv"
PDIV_OUTPUT_PATH = DATA_DIR / "price_divergence.csv"
from scorecard import compute_scorecard, list_filter_options


FEEDBACK_OUTPUT_PATH = Path(__file__).resolve().parent / "feedback" / "uat_feedback.xlsx"
FEEDBACK_STATUSES = {"New", "In Progress", "Completed"}


# In-memory cache
_cache: dict = {
    "dot_kpi": [],
    "iot_kpi": [],
    "supplier_assessment": [],
    "supplier_compliance": [],
    "supplier_maturity": [],
    "co2_emission": [],
    "eclipse": [],
    "invoice_conformity": [],
    "price_divergence": [],
    "feedback": [],
    "status": "idle",
    "last_refresh": None,
    "sa_status": "idle",
    "sa_last_refresh": None,
    "sc_status": "idle",
    "sc_last_refresh": None,
    "sm_status": "idle",
    "sm_last_refresh": None,
    "co2_status": "idle",
    "co2_last_refresh": None,
}
_lock = threading.Lock()
_sa_lock = threading.Lock()
_sc_lock = threading.Lock()
_sm_lock = threading.Lock()
_co2_lock = threading.Lock()
_feedback_lock = threading.Lock()

# ─── Pre-computed scorecard cache (Approach B2) ───────────────────────────────────
# Computed once at startup (and on /api/scorecard/rebuild) over the full
# population.  Endpoints with no zone/category filter serve from here
# (< 5 ms).  Zone/category-filtered requests fall back to on-the-fly
# computation because those filters change per-KPI row aggregation.
_scored_cache: dict = {}
_scored_cache_lock = threading.Lock()


class FeedbackCreateRequest(BaseModel):
    page: str
    username: str
    comment: str


class FeedbackUpdateRequest(BaseModel):
    status: str | None = None
    comment: str | None = None


def _normalize_feedback_rows(rows: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for item in rows:
        status = item.get("status", "New")
        status = status if status in FEEDBACK_STATUSES else "New"

        username = str(item.get("username", "")).strip()
        comment = str(item.get("comment", "")).strip()
        if not username or not comment:
            continue

        normalized.append({
            "id": str(item.get("id") or uuid4()),
            "page": str(item.get("page", "")).strip(),
            "username": username,
            "comment": comment,
            "status": status,
            "createdAt": str(item.get("createdAt") or datetime.now().isoformat()),
        })
    return normalized


def _load_feedback_from_disk():
    import pandas as pd

    if FEEDBACK_OUTPUT_PATH.exists():
        df = pd.read_excel(FEEDBACK_OUTPUT_PATH, dtype=str).fillna("")
        rows = _normalize_feedback_rows(df.to_dict(orient="records"))
        _cache["feedback"] = rows
    else:
        _cache["feedback"] = []
        _persist_feedback_to_disk()


def _persist_feedback_to_disk():
    import pandas as pd

    FEEDBACK_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    rows = _normalize_feedback_rows(_cache.get("feedback", []))
    df = pd.DataFrame(rows, columns=["id", "page", "username", "comment", "status", "createdAt"])
    df.to_excel(FEEDBACK_OUTPUT_PATH, index=False)


def _load_cache_from_disk():
    """Load cached CSVs from disk into memory cache."""
    import pandas as pd

    if DOT_OUTPUT_PATH.exists():
        df = pd.read_csv(DOT_OUTPUT_PATH, dtype=str).fillna("")
        _cache["dot_kpi"] = df.to_dict(orient="records")

    if IOT_OUTPUT_PATH.exists():
        df = pd.read_csv(IOT_OUTPUT_PATH, dtype=str).fillna("")
        _cache["iot_kpi"] = df.to_dict(orient="records")

    _cache["last_refresh"] = "loaded from disk"

    if SA_OUTPUT_PATH.exists():
        df = pd.read_csv(SA_OUTPUT_PATH, dtype=str).fillna("")
        _cache["supplier_assessment"] = df.to_dict(orient="records")
        _cache["sa_last_refresh"] = SA_OUTPUT_PATH.stat().st_mtime
    else:
        _cache["supplier_assessment"] = []

    if SC_OUTPUT_PATH.exists():
        df = pd.read_csv(SC_OUTPUT_PATH, dtype=str).fillna("")
        _cache["supplier_compliance"] = df.to_dict(orient="records")
        _cache["sc_last_refresh"] = SC_OUTPUT_PATH.stat().st_mtime
    else:
        _cache["supplier_compliance"] = []

    if SM_OUTPUT_PATH.exists():
        df = pd.read_csv(SM_OUTPUT_PATH, dtype=str).fillna("")
        _cache["supplier_maturity"] = df.to_dict(orient="records")
        _cache["sm_last_refresh"] = SM_OUTPUT_PATH.stat().st_mtime
    else:
        _cache["supplier_maturity"] = []

    if CO2_OUTPUT_PATH.exists():
        df = pd.read_csv(CO2_OUTPUT_PATH, dtype=str).fillna("")
        _cache["co2_emission"] = df.to_dict(orient="records")
        _cache["co2_last_refresh"] = CO2_OUTPUT_PATH.stat().st_mtime
    else:
        _cache["co2_emission"] = []

    if ECL_OUTPUT_PATH.exists():
        df = pd.read_csv(ECL_OUTPUT_PATH, dtype=str).fillna("")
        _cache["eclipse"] = df.to_dict(orient="records")
    else:
        _cache["eclipse"] = []

    if IC_OUTPUT_PATH.exists():
        df = pd.read_csv(IC_OUTPUT_PATH, dtype=str).fillna("")
        _cache["invoice_conformity"] = df.to_dict(orient="records")
    else:
        _cache["invoice_conformity"] = []

    if PDIV_OUTPUT_PATH.exists():
        df = pd.read_csv(PDIV_OUTPUT_PATH, dtype=str).fillna("")
        _cache["price_divergence"] = df.to_dict(orient="records")
    else:
        _cache["price_divergence"] = []

    _load_feedback_from_disk()


def _build_scored_cache() -> None:
    """Pre-compute the normalized scorecard for ALL parent suppliers.

    Uses the full KPI_CONFIGS (floor, target, weights, max_score) defined in
    scorecard.py as the single source of truth.  Percentile ranks are computed
    across the entire population so each parent's earned score reflects where
    it stands relative to all peers — matching the formula used by the
    individual KPI pages (softStretch mode).

    Call this at startup and via POST /api/scorecard/rebuild when config
    or data changes.
    """
    from datetime import datetime
    global _scored_cache

    result = compute_scorecard(_cache, include_kpi_breakdown=True, top_n=None)
    result["cached_at"] = datetime.now().isoformat()
    result["parent_count"] = len(result.get("scorecards", []))
    with _scored_cache_lock:
        _scored_cache = result


def _background_refresh_dot():
    """Fetch fresh DOT data from Databricks and update cache."""
    from datetime import datetime

    with _lock:
        if _cache["status"] == "refreshing":
            return
        _cache["status"] = "refreshing"

    try:
        raw = dot_fetch_raw()
        processed = dot_process(raw)
        DOT_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(DOT_OUTPUT_PATH, index=False)
        _cache["dot_kpi"] = processed.fillna("").to_dict(orient="records")
        _cache["last_refresh"] = datetime.now().isoformat()
        _cache["status"] = "ready"
    except Exception as e:
        _cache["status"] = f"error: {str(e)}"


def _background_refresh_iot():
    """Fetch fresh IOT data from Databricks and update cache."""
    from datetime import datetime

    with _lock:
        if _cache["status"] == "refreshing":
            return
        _cache["status"] = "refreshing"

    try:
        raw = iot_fetch_raw()
        processed = iot_process(raw)
        IOT_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(IOT_OUTPUT_PATH, index=False)
        _cache["iot_kpi"] = processed.fillna("").to_dict(orient="records")
        _cache["last_refresh"] = datetime.now().isoformat()
        _cache["status"] = "ready"
    except Exception as e:
        _cache["status"] = f"error: {str(e)}"


def _background_refresh_supplier_assessment():
    """Fetch fresh Supplier Assessment data from Databricks and update cache."""
    from datetime import datetime

    with _sa_lock:
        if _cache["sa_status"] == "refreshing":
            return
        _cache["sa_status"] = "refreshing"

    try:
        raw = sa_fetch_raw()
        processed = sa_process(raw)
        SA_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(SA_OUTPUT_PATH, index=False)

        _cache["supplier_assessment"] = processed.fillna("").to_dict(orient="records")
        _cache["sa_last_refresh"] = datetime.now().isoformat()
        _cache["sa_status"] = "ready"
    except Exception as e:
        _cache["sa_status"] = f"error: {str(e)}"


def _background_refresh_supplier_compliance():
    """Fetch fresh Supplier Compliance data from Databricks and update cache."""
    from datetime import datetime

    with _sc_lock:
        if _cache["sc_status"] == "refreshing":
            return
        _cache["sc_status"] = "refreshing"

    try:
        raw = sc_fetch_raw()
        processed = sc_process(raw)
        SC_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(SC_OUTPUT_PATH, index=False)

        _cache["supplier_compliance"] = processed.fillna("").to_dict(orient="records")
        _cache["sc_last_refresh"] = datetime.now().isoformat()
        _cache["sc_status"] = "ready"
    except Exception as e:
        _cache["sc_status"] = f"error: {str(e)}"


def _background_refresh_supplier_maturity():
    """Fetch fresh Supplier Maturity data from Databricks and update cache."""
    from datetime import datetime

    with _sm_lock:
        if _cache["sm_status"] == "refreshing":
            return
        _cache["sm_status"] = "refreshing"

    try:
        raw = sm_fetch_raw()
        processed = sm_process(raw)
        SM_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(SM_OUTPUT_PATH, index=False)

        _cache["supplier_maturity"] = processed.fillna("").to_dict(orient="records")
        _cache["sm_last_refresh"] = datetime.now().isoformat()
        _cache["sm_status"] = "ready"
    except Exception as e:
        _cache["sm_status"] = f"error: {str(e)}"


def _background_refresh_co2_emission():
    """Fetch fresh CO2 Emission data from Databricks and update cache."""
    from datetime import datetime

    with _co2_lock:
        if _cache["co2_status"] == "refreshing":
            return
        _cache["co2_status"] = "refreshing"

    try:
        raw = co2_fetch_raw()
        processed = co2_process(raw)
        CO2_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(CO2_OUTPUT_PATH, index=False)

        _cache["co2_emission"] = processed.fillna("").to_dict(orient="records")
        _cache["co2_last_refresh"] = datetime.now().isoformat()
        _cache["co2_status"] = "ready"
    except Exception as e:
        _cache["co2_status"] = f"error: {str(e)}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_cache_from_disk()
    _build_scored_cache()          # B2: pre-compute full scorecard at startup
    _cache["status"] = "ready"
    _cache["sa_status"] = "ready"
    _cache["sc_status"] = "ready"
    _cache["sm_status"] = "ready"
    _cache["co2_status"] = "ready"
    yield


app = FastAPI(title="SPM Scorecard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Gzip everything larger than ~1 KB — cuts the scorecard payload ~10×.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ─── DOT KPI endpoints ──────────────────────────────────────────────────────

@app.get("/api/dot-kpi")
def get_dot_kpi():
    return JSONResponse({
        "data": _cache["dot_kpi"],
        "count": len(_cache["dot_kpi"]),
        "status": _cache["status"],
        "last_refresh": _cache["last_refresh"],
    })


@app.post("/api/dot-kpi/refresh")
def refresh_dot_kpi():
    if _cache["status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})
    thread = threading.Thread(target=_background_refresh_dot, daemon=True)
    thread.start()
    return JSONResponse({"message": "DOT refresh started.", "status": "refreshing"})


# ─── IOT KPI endpoints ──────────────────────────────────────────────────────

@app.get("/api/iot-kpi")
def get_iot_kpi():
    return JSONResponse({
        "data": _cache["iot_kpi"],
        "count": len(_cache["iot_kpi"]),
        "status": _cache["status"],
        "last_refresh": _cache["last_refresh"],
    })


@app.post("/api/iot-kpi/refresh")
def refresh_iot_kpi():
    if _cache["status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})
    thread = threading.Thread(target=_background_refresh_iot, daemon=True)
    thread.start()
    return JSONResponse({"message": "IOT refresh started.", "status": "refreshing"})


# ─── Status ─────────────────────────────────────────────────────────────────

@app.get("/api/status")
def get_status():
    return JSONResponse({
        "status": _cache["status"],
        "dot_kpi_rows": len(_cache["dot_kpi"]),
        "iot_kpi_rows": len(_cache["iot_kpi"]),
        "last_refresh": _cache["last_refresh"],
        "sa_status": _cache["sa_status"],
        "supplier_assessment_rows": len(_cache["supplier_assessment"]),
        "sa_last_refresh": _cache["sa_last_refresh"],
        "sc_status": _cache["sc_status"],
        "supplier_compliance_rows": len(_cache["supplier_compliance"]),
        "sc_last_refresh": _cache["sc_last_refresh"],
        "sm_status": _cache["sm_status"],
        "supplier_maturity_rows": len(_cache["supplier_maturity"]),
        "sm_last_refresh": _cache["sm_last_refresh"],
        "co2_status": _cache["co2_status"],
        "co2_emission_rows": len(_cache["co2_emission"]),
        "co2_last_refresh": _cache["co2_last_refresh"],
    })


@app.get("/api/supplier-assessment")
def get_supplier_assessment():
    """Return cached Supplier Assessment data instantly."""
    return JSONResponse({
        "data": _cache["supplier_assessment"],
        "count": len(_cache["supplier_assessment"]),
        "status": _cache["sa_status"],
        "last_refresh": _cache["sa_last_refresh"],
    })


@app.post("/api/supplier-assessment/refresh")
def refresh_supplier_assessment():
    """Trigger background refresh of Supplier Assessment data from Databricks."""
    if _cache["sa_status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})

    thread = threading.Thread(
        target=_background_refresh_supplier_assessment, daemon=True,
    )
    thread.start()
    return JSONResponse({"message": "Refresh started.", "status": "refreshing"})


@app.get("/api/supplier-compliance")
def get_supplier_compliance():
    """Return cached Supplier Compliance data instantly."""
    return JSONResponse({
        "data": _cache["supplier_compliance"],
        "count": len(_cache["supplier_compliance"]),
        "status": _cache["sc_status"],
        "last_refresh": _cache["sc_last_refresh"],
    })


@app.post("/api/supplier-compliance/refresh")
def refresh_supplier_compliance():
    """Trigger background refresh of Supplier Compliance data from Databricks."""
    if _cache["sc_status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})

    thread = threading.Thread(
        target=_background_refresh_supplier_compliance, daemon=True,
    )
    thread.start()
    return JSONResponse({"message": "Refresh started.", "status": "refreshing"})


@app.get("/api/supplier-maturity")
def get_supplier_maturity():
    """Return cached Supplier Maturity data instantly."""
    return JSONResponse({
        "data": _cache["supplier_maturity"],
        "count": len(_cache["supplier_maturity"]),
        "status": _cache["sm_status"],
        "last_refresh": _cache["sm_last_refresh"],
    })


@app.post("/api/supplier-maturity/refresh")
def refresh_supplier_maturity():
    """Trigger background refresh of Supplier Maturity data from Databricks."""
    if _cache["sm_status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})

    thread = threading.Thread(
        target=_background_refresh_supplier_maturity, daemon=True,
    )
    thread.start()
    return JSONResponse({"message": "Refresh started.", "status": "refreshing"})


@app.get("/api/co2-emission")
def get_co2_emission():
    """Return cached CO2 Emission data instantly."""
    return JSONResponse({
        "data": _cache["co2_emission"],
        "count": len(_cache["co2_emission"]),
        "status": _cache["co2_status"],
        "last_refresh": _cache["co2_last_refresh"],
    })


@app.post("/api/co2-emission/refresh")
def refresh_co2_emission():
    """Trigger background refresh of CO2 Emission data from Databricks."""
    if _cache["co2_status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})

    thread = threading.Thread(
        target=_background_refresh_co2_emission, daemon=True,
    )
    thread.start()
    return JSONResponse({"message": "Refresh started.", "status": "refreshing"})


# ─── Eclipse Score endpoints ─────────────────────────────────────────────────

def _background_refresh_eclipse():
    from datetime import datetime
    try:
        raw = ecl_fetch_raw()
        processed = ecl_process(raw)
        ECL_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(ECL_OUTPUT_PATH, index=False)
        _cache["eclipse"] = processed.fillna("").to_dict(orient="records")
    except Exception as e:
        pass


@app.get("/api/eclipse")
def get_eclipse():
    """Return cached Eclipse Score data instantly."""
    return JSONResponse({
        "data": _cache["eclipse"],
        "count": len(_cache["eclipse"]),
    })


@app.post("/api/eclipse/refresh")
def refresh_eclipse():
    """Trigger background refresh of Eclipse data from Databricks."""
    thread = threading.Thread(target=_background_refresh_eclipse, daemon=True)
    thread.start()
    return JSONResponse({"message": "Eclipse refresh started."})


# ─── Invoice Conformity endpoints ────────────────────────────────────────────

def _background_refresh_ic():
    try:
        raw = ic_fetch_raw()
        processed = ic_process(raw)
        IC_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(IC_OUTPUT_PATH, index=False)
        _cache["invoice_conformity"] = processed.fillna("").to_dict(orient="records")
    except Exception:
        pass


@app.get("/api/invoice-conformity")
def get_invoice_conformity():
    return JSONResponse({
        "data": _cache["invoice_conformity"],
        "count": len(_cache["invoice_conformity"]),
    })


@app.post("/api/invoice-conformity/refresh")
def refresh_invoice_conformity():
    thread = threading.Thread(target=_background_refresh_ic, daemon=True)
    thread.start()
    return JSONResponse({"message": "Invoice Conformity refresh started."})


# ─── Price Divergence endpoints ──────────────────────────────────────────────

def _background_refresh_pdiv():
    try:
        raw = pdiv_fetch_raw()
        processed = pdiv_process(raw)
        PDIV_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(PDIV_OUTPUT_PATH, index=False)
        _cache["price_divergence"] = processed.fillna("").to_dict(orient="records")
    except Exception:
        pass


@app.get("/api/price-divergence")
def get_price_divergence():
    return JSONResponse({
        "data": _cache["price_divergence"],
        "count": len(_cache["price_divergence"]),
    })


@app.post("/api/price-divergence/refresh")
def refresh_price_divergence():
    thread = threading.Thread(target=_background_refresh_pdiv, daemon=True)
    thread.start()
    return JSONResponse({"message": "Price Divergence refresh started."})


# ─── Feedback endpoints (temporary UAT panel) ───────────────────────────────

@app.get("/api/feedback")
def get_feedback_comments(page: str | None = None):
    filtered = _cache["feedback"]
    if page:
        filtered = [item for item in filtered if str(item.get("page", "")).strip() == page]

    comments = sorted(
        filtered,
        key=lambda x: str(x.get("createdAt", "")),
        reverse=True,
    )
    return JSONResponse({
        "data": comments,
        "count": len(comments),
    })


@app.post("/api/feedback")
def create_feedback_comment(payload: FeedbackCreateRequest):
    page = payload.page.strip()
    username = payload.username.strip()
    comment = payload.comment.strip()
    if not page:
        raise HTTPException(status_code=400, detail="Page is required.")
    if not username:
        raise HTTPException(status_code=400, detail="Username is required.")
    if not comment:
        raise HTTPException(status_code=400, detail="Comment is required.")

    with _feedback_lock:
        record = {
            "id": str(uuid4()),
            "page": page,
            "username": username,
            "comment": comment,
            "status": "New",
            "createdAt": datetime.now().isoformat(),
        }
        _cache["feedback"] = [record, *_cache["feedback"]]
        _persist_feedback_to_disk()

    return JSONResponse({"comment": record})


@app.patch("/api/feedback/{comment_id}")
def update_feedback_comment(comment_id: str, payload: FeedbackUpdateRequest):
    with _feedback_lock:
        idx = next((i for i, item in enumerate(_cache["feedback"]) if item.get("id") == comment_id), None)
        if idx is None:
            raise HTTPException(status_code=404, detail="Comment not found.")

        record = dict(_cache["feedback"][idx])

        if payload.status is not None:
            if payload.status not in FEEDBACK_STATUSES:
                raise HTTPException(status_code=400, detail="Invalid status.")
            record["status"] = payload.status

        if payload.comment is not None:
            next_comment = payload.comment.strip()
            if not next_comment:
                raise HTTPException(status_code=400, detail="Comment is required.")
            record["comment"] = next_comment

        _cache["feedback"][idx] = record
        _persist_feedback_to_disk()

    return JSONResponse({"comment": record})


@app.delete("/api/feedback/{comment_id}")
def delete_feedback_comment(comment_id: str):
    with _feedback_lock:
        before = len(_cache["feedback"])
        _cache["feedback"] = [item for item in _cache["feedback"] if item.get("id") != comment_id]
        if len(_cache["feedback"]) == before:
            raise HTTPException(status_code=404, detail="Comment not found.")
        _persist_feedback_to_disk()

    return JSONResponse({"message": "Deleted."})


# ─── Normalized Scorecard endpoints ──────────────────────────────────────────

def _split_csv_param(value: str | None) -> list[str]:
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def _serve_scorecard(
    zones_param: str | None,
    categories_param: str | None,
    parents_param: str | None,
    include_kpi_breakdown: bool,
    top_n: int | None,
) -> dict:
    """Return scorecard data from cache when possible, else recompute.

    * No zone/category filter  → serve from pre-computed ``_scored_cache``
      (O(N) list filter, < 5 ms).
    * Zone or category filter  → recompute on the fly because those filters
      change which CSV rows feed each KPI’s aggregation.
    """
    zones = _split_csv_param(zones_param)
    categories = _split_csv_param(categories_param)
    parents = _split_csv_param(parents_param)

    # Zone/category filters change the aggregation — must recompute.
    if zones or categories or not _scored_cache:
        return compute_scorecard(
            _cache,
            zones=zones,
            categories=categories,
            parents=parents,
            include_kpi_breakdown=include_kpi_breakdown,
            top_n=top_n,
        )

    # Serve from pre-computed cache.
    all_scorecards: list[dict] = list(_scored_cache.get("scorecards", []))

    # Apply parent filter.
    if parents:
        parents_set = set(parents)
        all_scorecards = [s for s in all_scorecards if s["parentSupplier"] in parents_set]

    # Strip per-KPI breakdown for leaderboard view.
    if not include_kpi_breakdown:
        stripped = []
        for s in all_scorecards:
            sc = {**s}
            sc["pillars"] = [{k: v for k, v in p.items() if k != "kpis"} for p in s.get("pillars", [])]
            stripped.append(sc)
        all_scorecards = stripped

    # Apply top_n (rank by invoice value when no explicit parent filter).
    if top_n and top_n > 0 and not parents:
        all_scorecards = sorted(all_scorecards, key=lambda s: s["invoice_value"], reverse=True)[:top_n]

    return {
        **{k: v for k, v in _scored_cache.items() if k != "scorecards"},
        "scorecards": all_scorecards,
        "filters_applied": {
            "zones": zones,
            "categories": categories,
            "parents": parents,
            "top_n": top_n,
        },
    }


@app.get("/api/scorecard")
def get_scorecard(
    zones: str | None = None,
    categories: str | None = None,
    parents: str | None = None,
    top_n: int = 20,
):
    """
    Normalized Supplier Scorecard.

    Served from the pre-computed cache when no zone/category filter is applied
    (< 5 ms).  Zone/category filters trigger on-the-fly recomputation because
    those filters change per-KPI row aggregation.
    """
    result = _serve_scorecard(
        zones, categories, parents,
        include_kpi_breakdown=True,
        top_n=top_n if top_n and top_n > 0 else None,
    )
    return JSONResponse(result)


@app.get("/api/scorecard/leaderboard")
def get_scorecard_leaderboard(
    zones: str | None = None,
    categories: str | None = None,
    parents: str | None = None,
    top_n: int = 20,
):
    """
    Lightweight per-parent summary for the leaderboard view. Drops the per-KPI
    breakdown, keeping only pillar %s + normalized/coverage/adjusted totals.
    """
    result = _serve_scorecard(
        zones, categories, parents,
        include_kpi_breakdown=False,
        top_n=top_n if top_n and top_n > 0 else None,
    )
    return JSONResponse(result)


@app.get("/api/scorecard/parent")
def get_scorecard_parent(
    name: str,
    zones: str | None = None,
    categories: str | None = None,
):
    """
    Full drill-down (pillar + per-KPI breakdown) for a single parent supplier.
    Served from cache when no zone/category filter is applied.
    """
    result = _serve_scorecard(zones, categories, name, include_kpi_breakdown=True, top_n=None)
    parent = result["scorecards"][0] if result["scorecards"] else None
    return JSONResponse({
        "pillar_weights": result["pillar_weights"],
        "total_expected_kpi_weight": result["total_expected_kpi_weight"],
        "kpis": result["kpis"],
        "scorecard": parent,
        "cached_at": result.get("cached_at"),
    })


@app.get("/api/scorecard/filters")
def get_scorecard_filters():
    """Distinct zones / categories / parent suppliers across all KPI datasets."""
    return JSONResponse(list_filter_options(_cache))


@app.post("/api/scorecard/rebuild")
def rebuild_scorecard_cache():
    """Rebuild the pre-computed scorecard cache without restarting the server.

    Call this after:
    - Updating KPI config in scorecard.py (floor, target, max_score, weights)
    - Loading fresh CSV data via the individual KPI refresh endpoints
    """
    _build_scored_cache()
    return JSONResponse({
        "status": "ok",
        "message": "Scorecard cache rebuilt successfully.",
        "rebuilt_at": _scored_cache.get("cached_at"),
        "parent_count": _scored_cache.get("parent_count", 0),
    })


@app.get("/api/scorecard/cache-status")
def get_scorecard_cache_status():
    """Return metadata about the current pre-computed scorecard cache."""
    return JSONResponse({
        "cached_at": _scored_cache.get("cached_at"),
        "parent_count": _scored_cache.get("parent_count", 0),
        "is_ready": bool(_scored_cache),
    })


# ─── Serve built frontend (must be last) ────────────────────────────────────
from fastapi.staticfiles import StaticFiles

_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
