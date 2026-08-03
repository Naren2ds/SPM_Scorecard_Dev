# API Understanding — SPM Scorecard

Essential concepts on REST API design and data flow, grounded in this project.

---

## 1. REST API vs FastAPI

| Term | What it is |
|---|---|
| **REST API** | A design standard — rules for how client and server communicate over HTTP |
| **FastAPI** | A Python framework used to **build** a REST API |

> REST API = the rules of the road. FastAPI = the car you drive on that road.

---

## 2. REST Properties — Applied to This Project

| Property | How it applies here |
|---|---|
| **Client-Server** | React (`port 5173`) and FastAPI (`port 8000`) are fully separate and independently deployable |
| **Statelessness** | Every request includes all needed filters (zone, category, supplier) — the server stores no session data |
| **Cacheability** | KPI data is loaded once into `_cache` (RAM) at startup; every API call reads from cache, not Databricks |
| **Layered System** | React doesn't know if backend reads from CSV (sandbox) or Databricks (production) — same API URL either way |
| **Uniform Interface** | All communication uses standard HTTP methods (GET, POST, DELETE) with JSON responses |

---

## 3. Resources and HTTP Methods

Resources are **nouns** (what data). Methods are **verbs** (what action).

| Method | Endpoint | Action |
|---|---|---|
| `GET` | `/api/dot-kpi` | Fetch DOT KPI rows — read only, never changes data |
| `GET` | `/api/scorecard` | Fetch normalized scores for all suppliers |
| `GET` | `/api/status` | Check if a refresh is still running |
| `POST` | `/api/dot-kpi/refresh` | Trigger a data refresh from Databricks |
| `POST` | `/api/feedback` | Submit a new UAT feedback comment |
| `POST` | `/api/scorecard/config` | Update a KPI's floor / target / max score |
| `DELETE` | `/api/feedback/{id}` | Delete one specific feedback comment |

**Rule:** `GET` never modifies data. `POST` creates or triggers. `DELETE` removes.

---

## 4. JSON — The Communication Format

All data travels between React and FastAPI as JSON.

**Frontend calls the backend:**
```tsx
fetch("http://127.0.0.1:8000/api/scorecard")
  .then(res => res.json())
  .then(data => setScorecard(data));
```

**Backend responds with JSON:**
```json
{
  "scorecards": [
    {
      "parentSupplier": "ARDAGH GROUP",
      "normalized_score": 76.48,
      "band": "Amber",
      "pillars": [
        { "pillar": "Service Level", "earned_points": 18.4 }
      ]
    }
  ]
}
```

---

## 5. HTTP Return Codes Used in This Project

| Code | Meaning | When it happens |
|---|---|---|
| `200 OK` | Success | Scorecard / KPI data returned successfully |
| `400 Bad Request` | Client sent bad input | Empty username on feedback, invalid KPI config value |
| `404 Not Found` | Resource doesn't exist | Delete feedback with an ID that doesn't exist |
| `500 Internal Server Error` | Server crashed | Databricks connection fails |

---

## 6. DOT KPI — Full Data Flow (End to End)

```
[User clicks Refresh in UI]
        │
        ▼
POST /api/dot-kpi/refresh          ← triggers background refresh
        │
        ▼
Databricks SQL query               ← fetch raw delivery data
        │
        ▼
dot_process() → dot_kpi.csv        ← clean, rename, save to disk
        │
        ▼
_cache["dot_kpi"] updated in RAM   ← fast serving, no DB hit
        │
        ▼
_build_scored_cache()              ← DOT earned points recalculated
        │
        ▼
GET /api/scorecard                 ← React fetches updated scores
        │
        ▼
[UI shows updated Normalized Score for ARDAGH GROUP = 76.48]
```

### What happens at each step

| Step | Method | Endpoint | Response |
|---|---|---|---|
| User clicks Refresh | `POST` | `/api/dot-kpi/refresh` | `{ "status": "refreshing" }` |
| React polls progress | `GET` | `/api/status` | `{ "status": "ready" }` |
| React fetches DOT rows | `GET` | `/api/dot-kpi` | Array of DOT KPI rows as JSON |
| React fetches scorecard | `GET` | `/api/scorecard` | Normalized scores with DOT earned points |

### Key design choices

- The `POST /refresh` returns **immediately** with `200 OK` — the Databricks query runs in a background thread so the UI is never blocked.
- The scorecard is **pre-computed** (`_scored_cache`) after every refresh — `GET /api/scorecard` responds in under 5ms.
- The CSV file on disk is a **fallback** — if the server restarts, it reloads from CSV instead of hitting Databricks again.

---

## 7. GET /api/dot-kpi — Exact Trigger and Journey

### When does the GET fire?

**Automatically when the user opens the DOT KPI tab** — not on a button click.

As soon as `DotKpiPage` loads, it calls `loadFromApi()`:

```tsx
// DotKpiPage.tsx
const loadFromApi = () => {
    fetch("http://127.0.0.1:8000/api/dot-kpi")   // ← GET fires here
      .then(res => res.json())                     // ← convert response to JSON
      .then(json => {
          setRows(json.data)                        // ← data into React state → table renders
      })
}
```

### Complete journey

```
[User clicks DOT KPI tab in the browser]
              │
              ▼
   App.tsx sets activeKpi = "dot"
   → DotKpiPage component loads
              │
              ▼
   DotKpiPage.tsx fires:
   fetch("http://127.0.0.1:8000/api/dot-kpi")
              │
              ▼  ← travels over HTTP (localhost)
              │
   ┌─────────────────────────────────┐
   │        FastAPI server.py        │
   │                                 │
   │  @app.get("/api/dot-kpi")       │
   │  def get_dot_kpi():             │
   │    return {                     │
   │      "data": _cache["dot_kpi"] ◄── reads from RAM (NOT Databricks)
   │      "count": 5432,             │
   │      "status": "ready"          │
   │    }                            │
   └─────────────────────────────────┘
              │
              ▼  ← JSON travels back over HTTP
              │
   DotKpiPage.tsx receives JSON:
   {
     "data": [ { "supplier": "ARDAGH", "onTimePoLines": 450 }, ... ],
     "count": 5432,
     "status": "ready"
   }
              │
              ▼
   setRows(json.data) → React re-renders → table appears on screen
```

### Key points

| Question | Answer |
|---|---|
| **Who triggers the GET?** | `DotKpiPage.tsx` — automatically on tab open |
| **Where does it go?** | `http://127.0.0.1:8000/api/dot-kpi` (FastAPI backend) |
| **Where does FastAPI get the data?** | From `_cache["dot_kpi"]` in RAM — not Databricks, not CSV |
| **When was `_cache` filled?** | At server startup (from `dot_kpi.csv`) or after a POST refresh |
| **What comes back?** | JSON with `data`, `count`, `status` |
| **What does React do with it?** | Calls `setRows(json.data)` → table re-renders |

---

## 8. Python Decorators — What They Are and How This App Uses Them

### What is a decorator?

A decorator **wraps a function** to add extra behaviour around it — without changing the function itself.

**Real-world analogy:** A security guard at an office entrance. The employee still does their normal job. The guard just adds: check badge → log entry → let through → log exit. The guard *wraps* the activity.

### Simplest Python example

```python
# Without decorator — plain function
def say_hello():
    print("Hello!")

# Decorator — wraps say_hello with extra behaviour
def shout(func):
    def wrapper():
        print("*** ATTENTION ***")   # before
        func()                       # original function
        print("*** END ***")         # after
    return wrapper

@shout
def say_hello():
    print("Hello!")

say_hello()
# Output:
# *** ATTENTION ***
# Hello!
# *** END ***
```

### Without decorator vs with decorator — side by side

**Without decorator** — manual wiring (more code, separated):
```python
def get_dot_kpi():
    return {"data": _cache["dot_kpi"]}

app.add_api_route("/api/dot-kpi", get_dot_kpi, methods=["GET"])  # registered separately
```

**With decorator** — shortcut (cleaner, function and URL together):
```python
@app.get("/api/dot-kpi")         # ← URL registration + function in one place
def get_dot_kpi():
    return {"data": _cache["dot_kpi"]}
```

Both do **exactly the same thing**. The decorator is just cleaner.

### How decorators are used in this app

```python
# Register for GET (read data — never changes anything)
@app.get("/api/dot-kpi")
def get_dot_kpi():
    return _cache["dot_kpi"]

# Register for POST (trigger an action)
@app.post("/api/dot-kpi/refresh")
def refresh_dot():
    thread.start()
    return {"status": "refreshing"}

# Register for DELETE with a dynamic ID in the URL
@app.delete("/api/feedback/{comment_id}")
def delete_feedback(comment_id: str):
    # comment_id is extracted from URL automatically
    # DELETE /api/feedback/abc-123  →  comment_id = "abc-123"
    ...
```

### Mental model

```
@app.get("/api/dot-kpi")
    ↑          ↑
    │          └── URL path to listen on
    └── HTTP method

→ FastAPI builds an internal lookup table:
   GET  /api/dot-kpi          → call get_dot_kpi()
   POST /api/dot-kpi/refresh  → call refresh_dot()
   DELETE /api/feedback/{id}  → call delete_feedback(id)

→ When React calls fetch("http://127.0.0.1:8000/api/dot-kpi")
   FastAPI matches URL → calls get_dot_kpi() → returns JSON
```

**One line:** A decorator is a label you stick on a function. FastAPI reads that label to know *when* to call the function.
