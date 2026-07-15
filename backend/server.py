"""
FastAPI server for SPM Scorecard.
- Serves cached KPI data instantly
- Refreshes from Databricks in background on demand
"""

import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from fetch_dot_kpi import fetch_raw as dot_fetch_raw, process as dot_process, OUTPUT_PATH as DOT_OUTPUT_PATH
from fetch_iot_kpi import fetch_raw as iot_fetch_raw, process as iot_process, OUTPUT_PATH as IOT_OUTPUT_PATH


# In-memory cache
_cache: dict = {
    "dot_kpi": [], "iot_kpi": [],
    "status": "idle", "last_refresh": None,
}
_lock = threading.Lock()


def _load_cache_from_disk():
    """Load CSVs from disk into memory cache."""
    import pandas as pd

    if DOT_OUTPUT_PATH.exists():
        df = pd.read_csv(DOT_OUTPUT_PATH, dtype=str).fillna("")
        _cache["dot_kpi"] = df.to_dict(orient="records")

    if IOT_OUTPUT_PATH.exists():
        df = pd.read_csv(IOT_OUTPUT_PATH, dtype=str).fillna("")
        _cache["iot_kpi"] = df.to_dict(orient="records")

    _cache["last_refresh"] = "loaded from disk"


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_cache_from_disk()
    _cache["status"] = "ready"
    yield


app = FastAPI(title="SPM Scorecard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    })
