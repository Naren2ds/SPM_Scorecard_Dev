# Full Stack Learning — SPM Scorecard

A concise reference for understanding the React frontend and FastAPI backend used in this project, with examples pulled directly from the codebase.

---

## Tech Stack at a Glance

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Backend | FastAPI + Uvicorn (Python) |
| Data processing | Pandas |
| Database | Databricks SQL |
| Deployment | Databricks Apps (`app.yaml`) |

---

## Part 1 — React Frontend

### 1.1 The 3 Core Files

#### `index.html` — The Empty Shell
The browser loads this first. It is almost completely blank — just one `<div id="root">`. React fills this div with the entire app.

```html
<body>
  <div id="root"></div>   <!-- React fills this -->
  <script type="module" src="/src/main.tsx"></script>
</body>
```

#### `main.tsx` — The Boot Switch
Runs once on page load. Finds the empty `<div id="root">` and injects the `App` component into it.

```tsx
ReactDOM.createRoot(document.getElementById("root")).render(
  <App />
);
```

#### `App.tsx` — The Brain / Router
Decides which page to show based on which tab is active.

```tsx
function App() {
  const [activeKpi, setActiveKpi] = useState("summary");  // tracks active tab

  return (
    <main className="app-shell">
      <nav>
        <button onClick={() => setActiveKpi("scorecard")}>Normalized Scorecard</button>
        <button onClick={() => setActiveKpi("dot")}>DOT KPI</button>
      </nav>

      {activeKpi === "scorecard" && <ScorecardPage />}
      {activeKpi === "dot"       && <DotKpiPage />}
    </main>
  );
}
```

**Flow:**
```
Browser loads index.html
  → main.tsx boots → injects <App /> into <div id="root">
    → App.tsx renders tab bar + the active KPI page
      → User clicks "DOT" → DotKpiPage.tsx renders
```

---

### 1.2 Components

A component is a **TypeScript function that returns JSX (looks like HTML)**. Every page and widget in this project is a component.

```
App.tsx             → parent component (manages tabs)
ScorecardPage.tsx   → child component (Normalized Scorecard page)
DotKpiPage.tsx      → child component (DOT KPI page)
MultiSelectDropdown → reusable widget component
```

Components are used like HTML tags inside JSX:
```tsx
<ScorecardPage />
<DotKpiPage />
<MultiSelectDropdown label="Zone" options={zones} ... />
```

React runs the function and renders whatever it returns.

---

### 1.3 JSX

JSX is HTML-like syntax written inside TypeScript. The `{}` curly braces inject live TypeScript values.

```tsx
// Static — always "active"
className="active"

// Dynamic — "active" only when that tab is selected
className={activeKpi === "scorecard" ? "active" : ""}
```

From `App.tsx` — show `DotKpiPage` only when the DOT tab is open:
```tsx
{activeKpi === "dot" && <DotKpiPage />}
```

---

### 1.4 Props

Props are **inputs passed into a component**, like function arguments. They let you reuse the same component with different data.

`MultiSelectDropdown` in `ScorecardPage.tsx` is defined once and reused for Zone, Category, and Parent Supplier filters — just with different props each time:

```tsx
// Definition
function MultiSelectDropdown({
  label,      // dropdown title
  options,    // list of choices
  selected,   // currently selected values
  onChange,   // what to do when selection changes
  searchable, // show a search box?
}) { ... }

// Usage — reused 3 times with different props
<MultiSelectDropdown label="Zone"     options={zones}    selected={selectedZones}    onChange={setSelectedZones} />
<MultiSelectDropdown label="Category" options={cats}     selected={selectedCats}     onChange={setSelectedCats} />
<MultiSelectDropdown label="Supplier" options={parents}  selected={selectedParents}  onChange={setSelectedParents} searchable />
```

---

### 1.5 State

State is **data that changes and triggers the UI to re-render automatically**.

```tsx
// From App.tsx
const [activeKpi, setActiveKpi] = useState("summary");
//     ↑ current value            ↑ function to update it
```

- Read the value: `activeKpi`
- Change it: `setActiveKpi("dot")` → React re-renders and shows `<DotKpiPage />`

---

### 1.6 Full Component Picture

```
App.tsx
  ├── state: activeKpi = "scorecard"
  ├── renders tab buttons (props: onClick, className)
  └── renders <ScorecardPage />
        └── renders <MultiSelectDropdown label="Zone" options={[...]} />
              └── props control what the dropdown shows
```

---

## Part 2 — FastAPI Backend

### 2.1 How the Backend Works

The backend is a **REST API** built with FastAPI (Python). It:
1. Loads KPI data from CSV files (sandbox) or Databricks SQL (production)
2. Runs scoring calculations via `scorecard.py`
3. Exposes the results as JSON endpoints that the React frontend calls

**Server entry point:** `apps/backend/server.py`
**Scoring logic:** `apps/backend/scorecard.py`

---

### 2.2 Frontend → Backend Communication

The React frontend calls the FastAPI backend over HTTP:

```tsx
// From ScorecardPage.tsx
const API_BASE = "http://127.0.0.1:8000";

fetch(`${API_BASE}/api/scorecard`)
  .then(res => res.json())
  .then(data => setScorecard(data));
```

The backend responds with a JSON object containing normalized scores, pillar breakdowns, and KPI details for every parent supplier.

---

### 2.3 Data Flow End to End

```
CSV files / Databricks
        ↓
  server.py loads data into memory cache
        ↓
  scorecard.py computes normalized scores
        ↓
  FastAPI returns JSON via /api/scorecard
        ↓
  React (ScorecardPage.tsx) receives JSON
        ↓
  UI renders the scorecard table
```

---

### 2.4 Running Locally

```cmd
# Terminal 1 — Backend
cd apps\backend
python server.py

# Terminal 2 — Frontend
cd apps\frontend
npm install
npm run dev
```

Frontend runs at `http://127.0.0.1:5173`
Backend runs at `http://127.0.0.1:8000`
