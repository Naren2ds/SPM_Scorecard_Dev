// ---------------------------------------------------------------------------
// CO2 Emission KPI Page
// Same layout as Supplier Compliance but:
//   - Value is absolute tonnes CO2e (no % display)
//   - Critical Floor / Target defaults come from Q1 / Q3 of the currently
//     filtered rows (auto-derive checkbox; user can override).
//   - Rollups: Zone + Parent only.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateParentRollup,
  calculateSupplierScores,
  calculateZoneRollup,
  computeQuartileDefaults,
  formulaModeLabel,
  toCsv,
  validateConfig,
} from "./co2EmissionScoring";
import type {
  Co2Config,
  Co2EmissionInputRow,
  Co2FormulaMode,
  RollupCo2Row,
  ScoredCo2Row,
} from "./co2EmissionTypes";

// ─── Helpers ────────────────────────────────────────────────────────────────

const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value)
    ? "-"
    : `${(value * 100).toFixed(digits)}%`;

const numeric = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);

const tonnes = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value)
    ? "-"
    : value.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

const formatRank = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "-"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(1);

const displayText = (value: string, fallback: string) =>
  (value ?? "").trim() || fallback;

// ─── Multi-select dropdown (matches DOT/SA/SC UX) ──────────────────────────

function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggleValue = (val: string) => {
    if (selected.includes(val)) onChange(selected.filter((v) => v !== val));
    else onChange([...selected, val]);
  };

  const displayLabel =
    selected.length === 0
      ? "All"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  return (
    <div className="ms-dropdown" ref={ref}>
      <span className="ms-label">{label}</span>
      <button type="button" className="ms-trigger" onClick={() => setOpen(!open)}>
        {displayLabel} <span className="ms-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="ms-panel">
          <label className="ms-item">
            <input
              type="checkbox"
              checked={selected.length === 0}
              onChange={() => onChange([])}
            />
            All
          </label>
          {options.map((opt) => (
            <label key={opt} className="ms-item">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggleValue(opt)}
              />
              {opt}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

const API_BASE = "http://127.0.0.1:8000";

function Co2EmissionPage() {
  const [rows, setRows] = useState<Co2EmissionInputRow[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [config, setConfig] = useState<Co2Config>({
    maxScore: 10,
    criticalFloor: 0,
    target: 1,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });

  // When true, Floor/Target auto-track Q1/Q3 of the currently filtered rows.
  const [autoQuartiles, setAutoQuartiles] = useState(true);

  // Multi-select filter states (empty = All). Year defaults to "2024" to
  // match the source column `emissions_tco2e_2024`.
  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>(["2024"]);
  const [selParent, setSelParent] = useState<string[]>([]);
  const [selSupplier, setSelSupplier] = useState<string[]>([]);
  const [selZone, setSelZone] = useState<string[]>([]);

  // ─── Load cached data from API on mount ─────────────────────────────────
  const loadFromApi = () => {
    fetch(`${API_BASE}/api/co2-emission`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data && json.data.length > 0) {
          const parsed: Co2EmissionInputRow[] = json.data.map(
            (row: Record<string, string>, i: number) => ({
              id: row.id || `api-${i}`,
              supplier: row.supplier || "",
              parentSupplier: row.parentSupplier || "",
              zone: row.zone || "",
              category: row.category || "",
              kpiApplicability:
                row.kpiApplicability === "Not Applicable"
                  ? ("Not Applicable" as const)
                  : ("Applicable" as const),
              co2Emission: row.co2Emission || "",
              year: row.year || "",
            }),
          );
          setRows(parsed);
          setStatusMessage(`${parsed.length} rows loaded.`);
        } else {
          setStatusMessage(
            "No cached CO2 Emission data. Click Refresh Data to fetch from Databricks.",
          );
        }
      })
      .catch(() => {
        setStatusMessage("Backend not running. Start it with run.bat.");
      });
  };

  useEffect(() => {
    loadFromApi();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    setStatusMessage("Refreshing from Databricks...");
    fetch(`${API_BASE}/api/co2-emission/refresh`, { method: "POST" })
      .then(() => {
        const poll = setInterval(() => {
          fetch(`${API_BASE}/api/status`)
            .then((res) => res.json())
            .then((json) => {
              if (json.co2_status !== "refreshing") {
                clearInterval(poll);
                setRefreshing(false);
                loadFromApi();
              }
            });
        }, 2000);
      })
      .catch(() => {
        setRefreshing(false);
        setStatusMessage("Refresh failed.");
      });
  };

  // ─── Dynamic filter options ─────────────────────────────────────────────
  const opts = useMemo(
    () => ({
      categories: Array.from(
        new Set(rows.map((r) => r.category).filter(Boolean)),
      ).sort(),
      years: Array.from(
        new Set(rows.map((r) => r.year).filter(Boolean)),
      ).sort(),
      parents: Array.from(
        new Set(rows.map((r) => r.parentSupplier).filter(Boolean)),
      ).sort(),
      suppliers: Array.from(
        new Set(rows.map((r) => r.supplier).filter(Boolean)),
      ).sort(),
      zones: Array.from(new Set(rows.map((r) => r.zone).filter(Boolean))).sort(),
    }),
    [rows],
  );

  // ─── Apply filters ──────────────────────────────────────────────────────
  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (selCategory.length > 0 && !selCategory.includes(row.category))
          return false;
        if (selYear.length > 0 && !selYear.includes(row.year)) return false;
        if (selParent.length > 0 && !selParent.includes(row.parentSupplier))
          return false;
        if (selSupplier.length > 0 && !selSupplier.includes(row.supplier))
          return false;
        if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
        return true;
      }),
    [rows, selCategory, selYear, selParent, selSupplier, selZone],
  );

  // ─── Quartile defaults (Floor = Q1, Target = Q3) ────────────────────────
  const quartiles = useMemo(
    () => computeQuartileDefaults(filteredRows),
    [filteredRows],
  );

  // Apply auto-quartile defaults to config whenever filtered data changes
  // (only when the user has NOT manually overridden the values).
  useEffect(() => {
    if (!autoQuartiles) return;
    if (quartiles.q1 === null || quartiles.q3 === null) return;
    // Guard against equal Q1/Q3 (no variance) — push target slightly above.
    const q1 = quartiles.q1;
    let q3 = quartiles.q3;
    if (q3 <= q1) q3 = q1 + 1;
    setConfig((c) => ({ ...c, criticalFloor: q1, target: q3 }));
  }, [autoQuartiles, quartiles.q1, quartiles.q3]);

  // ─── Scoring ────────────────────────────────────────────────────────────
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;

  const supplierScores = useMemo(
    () => (configIsValid ? calculateSupplierScores(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );
  const zoneRollup = useMemo(
    () => (configIsValid ? calculateZoneRollup(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );
  const parentRollup = useMemo(
    () => (configIsValid ? calculateParentRollup(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );

  // ─── Config helpers ─────────────────────────────────────────────────────
  const updateNumericConfig = (
    field: "maxScore" | "criticalFloor" | "target",
    value: string,
  ) => {
    setConfig((c) => ({
      ...c,
      [field]: value === "" ? Number.NaN : Number(value),
    }));
    if (field === "criticalFloor" || field === "target") {
      setAutoQuartiles(false);
    }
  };

  const resetToQuartiles = () => {
    setAutoQuartiles(true);
  };

  // ─── Export ─────────────────────────────────────────────────────────────
  const exportResults = () => {
    const csv = toCsv([
      ["CO2 Emission Config"],
      ["Max Score", config.maxScore],
      ["Critical Floor (tCO2e)", numeric(config.criticalFloor, 4)],
      ["Target (tCO2e)", numeric(config.target, 4)],
      ["Formula", formulaModeLabel(config.formulaMode)],
      ["Auto Quartile Defaults", autoQuartiles ? "Yes" : "No"],
      ["Q1 (filtered)", numeric(quartiles.q1, 4)],
      ["Q3 (filtered)", numeric(quartiles.q3, 4)],
      ["Rows (after filters)", filteredRows.length],
      [],
      ["Supplier Level"],
      ["Supplier", "Parent", "Zone", "Category", "CO2 (tCO2e)", "Rank", "Percentile %", "Attainment", "Max", "Earned", "Score %", "Status"],
      ...supplierScores.map((r) => [r.supplier, r.parentSupplier, r.zone, r.category, tonnes(r.co2Emission, 2), formatRank(r.rankDescending), percent(r.percentile, 2), numeric(r.attainmentFactor, 4), numeric(r.maxScore, 2), numeric(r.earnedScore, 2), percent(r.scorePercent, 2), r.scoreStatus]),
      [],
      ["Zone Rollup"],
      ...rollupExportRows(zoneRollup, "Zone"),
      [],
      ["Parent Rollup"],
      ...rollupExportRows(parentRollup, "Parent Supplier"),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "co2-emission-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Header */}
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Sustainability KPI</p>
          <h1>CO<sub>2</sub> Emission — Percentile Scoring</h1>
          <p className="kpi-value-note">
            CO<sub>2</sub> Reduction Potential (tonnes CO<sub>2</sub>e) is sourced per supplier. Higher value = better. Critical Floor and Target default to Q1 / Q3 of the currently filtered rows.
          </p>
          {statusMessage && <p className="supporting">{statusMessage}</p>}
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh Data"}
          </button>
          <button
            type="button"
            onClick={exportResults}
            disabled={!configIsValid || filteredRows.length === 0}
          >
            Export Results
          </button>
        </div>
      </section>

      {/* Filters Row */}
      <section className="config-bar">
        <MultiSelectDropdown label="Category" options={opts.categories} selected={selCategory} onChange={setSelCategory} />
        <MultiSelectDropdown label="Year" options={opts.years} selected={selYear} onChange={setSelYear} />
        <MultiSelectDropdown label="Parent Supplier" options={opts.parents} selected={selParent} onChange={setSelParent} />
        <MultiSelectDropdown label="Supplier" options={opts.suppliers} selected={selSupplier} onChange={setSelSupplier} />
        <MultiSelectDropdown label="Zone" options={opts.zones} selected={selZone} onChange={setSelZone} />
        <div className="filter-summary">
          <strong>{filteredRows.length}</strong> / {rows.length} rows
        </div>
      </section>

      {/* Configuration Row */}
      <section className="config-bar">
        <label>
          <span>Max Score</span>
          <input
            type="number"
            min="0"
            step="0.5"
            value={Number.isFinite(config.maxScore) ? config.maxScore : ""}
            onChange={(e) => updateNumericConfig("maxScore", e.target.value)}
          />
        </label>
        <label>
          <span>Critical Floor (tCO<sub>2</sub>e)</span>
          <input
            type="number"
            min="0"
            step="any"
            value={Number.isFinite(config.criticalFloor) ? Number(config.criticalFloor.toFixed(4)) : ""}
            onChange={(e) => updateNumericConfig("criticalFloor", e.target.value)}
          />
        </label>
        <label>
          <span>Target (tCO<sub>2</sub>e)</span>
          <input
            type="number"
            min="0"
            step="any"
            value={Number.isFinite(config.target) ? Number(config.target.toFixed(4)) : ""}
            onChange={(e) => updateNumericConfig("target", e.target.value)}
          />
        </label>
        <label>
          <span>Formula Mode</span>
          <select
            value={config.formulaMode}
            onChange={(e) => setConfig((c) => ({ ...c, formulaMode: e.target.value as Co2FormulaMode }))}
          >
            <option value="softStretch">Softer Percentile Stretch</option>
            <option value="strict">Strict Percentile &times; Attainment</option>
          </select>
        </label>
        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={autoQuartiles}
            onChange={(e) => {
              if (e.target.checked) resetToQuartiles();
              else setAutoQuartiles(false);
            }}
          />
          <span>Auto Q1 / Q3 defaults</span>
        </label>
        <div className="filter-summary">
          Q1: <strong>{numeric(quartiles.q1, 2)}</strong> &middot; Q3: <strong>{numeric(quartiles.q3, 2)}</strong>
        </div>
        {configErrors.length > 0 && (
          <div className="validation-box config-bar-errors">
            {configErrors.map((err) => <p key={err}>{err}</p>)}
          </div>
        )}
      </section>

      {/* Data Summary */}
      <section className="input-panel">
        <div className="panel-heading">
          <div>
            <h2>Data Summary</h2>
            <p className="supporting">
              {rows.length > 0
                ? `${rows.length} total rows loaded. Showing ${filteredRows.length} after filters.`
                : "No data. Click Refresh Data to fetch from Databricks."}
            </p>
          </div>
        </div>
      </section>

      {/* How CO2 Emission Earned Score is Calculated */}
      <details className="formula-panel collapsible-section" open>
        <summary>How CO<sub>2</sub> Emission Earned Score Is Calculated</summary>
        <div className="formula-ribbon" aria-label="CO2 Emission formula summary">
          <div>
            <span>1. Earned Score</span>
            <strong>
              {config.formulaMode === "strict"
                ? "Max Score × Percentile × Attainment"
                : "Max Score × Attainment × (70% + 30% × Percentile)"}
            </strong>
          </div>
          <div>
            <span>2. Attainment</span>
            <strong>(Value &minus; Floor) / (Target &minus; Floor), clamped 0&ndash;1</strong>
          </div>
          <div>
            <span>3. Percentile</span>
            <strong>(N &minus; Rank) / (N &minus; 1). Rank 1 = highest value = 100th percentile.</strong>
          </div>
        </div>
        <div className="formula-callout">
          <strong>Selected formula:</strong>{" "}
          {config.formulaMode === "softStretch"
            ? "Softer Percentile Stretch — Earned Score = Max Score × Attainment × (70% + 30% × Percentile)"
            : "Strict Percentile × Attainment — Earned Score = Max Score × Percentile × Attainment"}
        </div>
        <details className="formula-details">
          <summary>Show short explanation</summary>
          <ul>
            <li><strong>CO<sub>2</sub> value arrives pre-computed</strong> from the source system as absolute tonnes CO<sub>2</sub>e. Higher = better.</li>
            <li><strong>Critical Floor and Target</strong> default to Q1 and Q3 of the currently filtered rows respectively. Toggle off "Auto Q1 / Q3 defaults" to enter manual values.</li>
            <li><strong>Rank valid suppliers within the selected cohort.</strong> Highest value = Rank 1 = strongest percentile.</li>
            <li><strong>Below floor</strong> → Attainment = 0 → Earned Score = 0.</li>
            <li><strong>Softer formula protects 70% of the attainment-adjusted score</strong> even at 0th percentile — 30% is stretched by rank.</li>
            <li><strong>Rollups (Zone and Parent) use simple average</strong> of contributing suppliers — flagged as <em>Proxy Calculation</em>.</li>
          </ul>
        </details>
      </details>

      {/* Results */}
      <section className="results-panel">
        <h2>Calculation Results</h2>
        {filteredRows.length === 0 ? (
          <div className="empty-state">No data matches filters.</div>
        ) : !configIsValid ? (
          <div className="empty-state">Fix configuration errors.</div>
        ) : (
          <div className="calculation-stack">
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">1</span>
                <h3>Supplier Level ({supplierScores.length} rows{supplierScores.length > 200 ? ", showing first 200" : ""})</h3>
              </summary>
              <div className="rollup-scroll"><SupplierResults rows={supplierScores.slice(0, 200)} /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">2</span><h3>Zone Rollup ({zoneRollup.length})</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={zoneRollup} label="Zone" /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">3</span><h3>Parent Rollup ({parentRollup.length})</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={parentRollup} label="Parent Supplier" /></div>
            </details>
          </div>
        )}
      </section>
    </>
  );
}

// ─── Result Tables ─────────────────────────────────────────────────────────

function SupplierResults({ rows }: { rows: ScoredCo2Row[] }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>Supplier</th><th>Parent</th><th>Zone</th><th>Category</th>
          <th>CO<sub>2</sub> (tCO<sub>2</sub>e)</th>
          <th>Rank</th><th>Percentile</th><th>Attainment</th>
          <th>Max</th><th>Earned</th><th>Score %</th><th>Status</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{displayText(row.supplier, "Unassigned")}</td>
              <td>{displayText(row.parentSupplier, "")}</td>
              <td>{displayText(row.zone, "")}</td>
              <td>{displayText(row.category, "")}</td>
              <td>{tonnes(row.co2Emission, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RollupResults({
  rows,
  label,
}: {
  rows: RollupCo2Row[];
  label: string;
}) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>{label}</th>
          <th>CO<sub>2</sub> (tCO<sub>2</sub>e)</th>
          <th>Rank</th><th>Percentile</th><th>Attainment</th>
          <th>Max</th><th>Earned</th><th>Score %</th>
          <th>Contributing</th><th>Aggregation</th><th>Status</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{row.label}</td>
              <td>{tonnes(row.co2Emission, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td>{row.contributingSuppliers}</td>
              <td>{row.aggregationMethod}</td>
              <td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Export helper ─────────────────────────────────────────────────────────

const rollupExportRows = (rows: RollupCo2Row[], label: string) => [
  [label, "CO2 (tCO2e)", "Rank", "Percentile %", "Attainment", "Max", "Earned", "Score %", "Contributing", "Aggregation", "Status"],
  ...rows.map((r) => [
    r.label,
    tonnes(r.co2Emission, 2),
    formatRank(r.rankDescending),
    percent(r.percentile, 2),
    numeric(r.attainmentFactor, 4),
    numeric(r.maxScore, 2),
    numeric(r.earnedScore, 2),
    percent(r.scorePercent, 2),
    r.contributingSuppliers,
    r.aggregationMethod,
    r.scoreStatus,
  ]),
];

// ─── Status styling ────────────────────────────────────────────────────────

const rowClass = (status: string) => {
  if (status === "Invalid Data") return "invalid-row";
  if (status === "Not Applicable" || status === "Missing Value") {
    return "not-applicable-row";
  }
  return "";
};

const statusClass = (status: string) => {
  if (status === "Invalid Data") return "status-invalid";
  if (status === "Not Applicable" || status === "Missing Value") {
    return "status-na";
  }
  if (status === "Zero Score") return "status-floor";
  if (
    status === "No Variance" ||
    status === "Single Observation" ||
    status === "Proxy Calculation"
  ) {
    return "status-note";
  }
  return "status-valid";
};

export default Co2EmissionPage;
