"""
FastAPI server for SPM Scorecard.
- Serves cached DOT KPI data instantly
- Refreshes from Databricks in background on demand
"""

import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from fetch_dot_kpi import fetch_raw, process, OUTPUT_PATH
from fetch_supplier_assessment import (
    fetch_raw as sa_fetch_raw,
    process as sa_process,
    OUTPUT_PATH as SA_OUTPUT_PATH,
)
from fetch_supplier_compliance import (
    fetch_raw as sc_fetch_raw,
    process as sc_process,
    OUTPUT_PATH as SC_OUTPUT_PATH,
)


# In-memory cache
_cache: dict = {
    "dot_kpi": [],
    "supplier_assessment": [],
    "supplier_compliance": [],
    "status": "idle",
    "last_refresh": None,
    "sa_status": "idle",
    "sa_last_refresh": None,
    "sc_status": "idle",
    "sc_last_refresh": None,
}
_lock = threading.Lock()
_sa_lock = threading.Lock()
_sc_lock = threading.Lock()


def _load_cache_from_disk():
    """Load cached CSVs from disk into memory cache."""
    import pandas as pd

    if OUTPUT_PATH.exists():
        df = pd.read_csv(OUTPUT_PATH, dtype=str).fillna("")
        _cache["dot_kpi"] = df.to_dict(orient="records")
        _cache["last_refresh"] = OUTPUT_PATH.stat().st_mtime
    else:
        _cache["dot_kpi"] = []

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


def _background_refresh():
    """Fetch fresh DOT KPI data from Databricks and update cache."""
    from datetime import datetime

    with _lock:
        if _cache["status"] == "refreshing":
            return
        _cache["status"] = "refreshing"

    try:
        raw = fetch_raw()
        processed = process(raw)
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        processed.to_csv(OUTPUT_PATH, index=False)

        _cache["dot_kpi"] = processed.fillna("").to_dict(orient="records")
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # On startup: load cached data from disk (instant)
    _load_cache_from_disk()
    _cache["status"] = "ready"
    _cache["sa_status"] = "ready"
    _cache["sc_status"] = "ready"
    yield


app = FastAPI(title="SPM Scorecard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/dot-kpi")
def get_dot_kpi():
    """Return cached DOT KPI data instantly."""
    return JSONResponse({
        "data": _cache["dot_kpi"],
        "count": len(_cache["dot_kpi"]),
        "status": _cache["status"],
        "last_refresh": _cache["last_refresh"],
    })


@app.post("/api/dot-kpi/refresh")
def refresh_dot_kpi():
    """Trigger background refresh from Databricks."""
    if _cache["status"] == "refreshing":
        return JSONResponse({"message": "Refresh already in progress.", "status": "refreshing"})

    thread = threading.Thread(target=_background_refresh, daemon=True)
    thread.start()
    return JSONResponse({"message": "Refresh started.", "status": "refreshing"})


@app.get("/api/status")
def get_status():
    """Health check and cache status."""
    return JSONResponse({
        "status": _cache["status"],
        "dot_kpi_rows": len(_cache["dot_kpi"]),
        "last_refresh": _cache["last_refresh"],
        "sa_status": _cache["sa_status"],
        "supplier_assessment_rows": len(_cache["supplier_assessment"]),
        "sa_last_refresh": _cache["sa_last_refresh"],
        "sc_status": _cache["sc_status"],
        "supplier_compliance_rows": len(_cache["supplier_compliance"]),
        "sc_last_refresh": _cache["sc_last_refresh"],
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
