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


# In-memory cache
_cache: dict = {"dot_kpi": [], "status": "idle", "last_refresh": None}
_lock = threading.Lock()


def _load_cache_from_disk():
    """Load CSV from disk into memory cache."""
    import pandas as pd

    if OUTPUT_PATH.exists():
        df = pd.read_csv(OUTPUT_PATH, dtype=str).fillna("")
        _cache["dot_kpi"] = df.to_dict(orient="records")
        _cache["last_refresh"] = OUTPUT_PATH.stat().st_mtime
    else:
        _cache["dot_kpi"] = []


def _background_refresh():
    """Fetch fresh data from Databricks and update cache."""
    import pandas as pd
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # On startup: load cached data from disk (instant)
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
    })
