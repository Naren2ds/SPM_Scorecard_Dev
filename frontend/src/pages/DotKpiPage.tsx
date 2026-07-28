import { useEffect, useMemo, useRef, useState } from "react";
import { MultiSelectDropdown } from "../shared/MultiSelectDropdown";
import {
  calculateCategoryRollup,
  calculateParentRollup,
  calculateZoneRollup,
  scoreSupplierRows,
  validateConfig,
  validateRows,
} from "../shared/scoring";
import { parseSupplierRowsFromCsv, toCsv } from "../shared/csv";
import type {
  KpiConfig,
  RollupRow,
  ScoredKpiRow,
  SupplierKpiInputRow,
} from "../shared/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const emptyRow = (id: string): SupplierKpiInputRow => ({
  id,
  supplier: "",
  parentSupplier: "",
  zone: "",
  country: "",
  category: "",
  kpiApplicability: "Applicable",
  dotPercent: "",
  onTimePoLines: "",
  totalDeliveredPoLines: "",
  x1DelayedOver30Days: "",
  x2EarlyOver30Days: "",
  year: "",
  month: "",
});

const dotFields: Array<{
  key: keyof SupplierKpiInputRow;
  label: string;
  width: string;
  type?: string;
  options?: Array<SupplierKpiInputRow[keyof SupplierKpiInputRow]>;
}> = [
  { key: "supplier", label: "Supplier", width: "150px" },
  { key: "parentSupplier", label: "Parent Supplier", width: "165px" },
  { key: "zone", label: "Zone", width: "110px" },
  { key: "country", label: "Country", width: "110px" },
  { key: "category", label: "Category", width: "140px" },
  {
    key: "kpiApplicability",
    label: "KPI Applicability",
    width: "155px",
    options: ["Applicable", "Not Applicable"],
  },
  { key: "dotPercent", label: "DOT % Override", width: "135px" },
  { key: "onTimePoLines", label: "On-Time PO Lines", width: "130px", type: "number" },
  { key: "totalDeliveredPoLines", label: "Total Delivered PO Lines", width: "160px", type: "number" },
  { key: "x1DelayedOver30Days", label: "X1 Delayed >30d", width: "140px", type: "number" },
  { key: "x2EarlyOver30Days", label: "X2 Early >30d", width: "130px", type: "number" },
];

const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(digits)}%`;

const numeric = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);

const formatRank = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "-" : String(Math.floor(value));

const rawInt = (value: number | null | undefined) =>
  value == null ? "-" : String(value);

const displayText = (value: string, fallback: string) => value.trim() || fallback;

const normalizeMonth = (m: string) => m.replace(/^0+/, "") || m;

// ─── Main Page ──────────────────────────────────────────────────────────────

function DotKpiPage() {
  const [rows, setRows] = useState<SupplierKpiInputRow[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [config, setConfig] = useState<KpiConfig>({
    maxScore: 15,
    criticalFloor: 0.7,
    target: 0.85,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });

  // Multi-select filter states (empty = All)
  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>(["2025", "2026"]);
  const [selMonth, setSelMonth] = useState<string[]>([]);
  const [selParentSupplier, setSelParentSupplier] = useState<string[]>([]);
  const [selSupplier, setSelSupplier] = useState<string[]>([]);
  const [selCountry, setSelCountry] = useState<string[]>([]);
  const [selZone, setSelZone] = useState<string[]>([]);

  const [refreshing, setRefreshing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const API_BASE = "http://127.0.0.1:8000";

  // Load cached data from API on mount
  const loadFromApi = () => {
    fetch(`${API_BASE}/api/dot-kpi`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data && json.data.length > 0) {
          const parsed: SupplierKpiInputRow[] = json.data.map(
            (row: Record<string, string>, i: number) => ({
              id: row.id || `api-${i}`,
              supplier: row.supplier || "",
              parentSupplier: row.parentSupplier || "",
              zone: row.zone || "",
              country: row.country || "",
              category: row.category || "",
              kpiApplicability:
                row.kpiApplicability === "Not Applicable"
                  ? ("Not Applicable" as const)
                  : ("Applicable" as const),
              dotPercent: row.dotPercent || "",
              onTimePoLines: row.onTimePoLines || "",
              totalDeliveredPoLines: row.totalDeliveredPoLines || "",
              x1DelayedOver30Days: row.x1DelayedOver30Days || "",
              x2EarlyOver30Days: row.x2EarlyOver30Days || "",
              year: row.year || "",
              month: row.month || "",
            }),
          );
          setRows(parsed);
          setUploadMessage(`${parsed.length} rows loaded.`);
        }
      })
      .catch(() => {
        setUploadMessage("Backend not running. Upload CSV manually.");
      });
  };

  useEffect(() => { loadFromApi(); }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    setUploadMessage("Refreshing from Databricks...");
    fetch(`${API_BASE}/api/dot-kpi/refresh`, { method: "POST" })
      .then(() => {
        const poll = setInterval(() => {
          fetch(`${API_BASE}/api/status`)
            .then((res) => res.json())
            .then((json) => {
              if (json.status !== "refreshing") {
                clearInterval(poll);
                setRefreshing(false);
                loadFromApi();
              }
            });
        }, 2000);
      })
      .catch(() => { setRefreshing(false); setUploadMessage("Refresh failed."); });
  };

  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsedRows = parseSupplierRowsFromCsv(text);
    if (parsedRows.length === 0) { setUploadMessage("No rows found in CSV."); return; }
    setRows(parsedRows);
    setUploadMessage(`${parsedRows.length} rows loaded from ${file.name}.`);
    event.target.value = "";
  };

  // ─── Dynamic filter options ─────────────────────────────────────────────
  const opts = useMemo(() => ({
    categories: Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort(),
    years: ["2025", "2026"],
    months: Array.from(new Set(rows.map((r) => r.month).filter(Boolean))).sort((a, b) => Number(a) - Number(b)),
    parentSuppliers: Array.from(new Set(rows.map((r) => r.parentSupplier).filter(Boolean))).sort(),
    suppliers: Array.from(new Set(rows.map((r) => r.supplier).filter(Boolean))).sort(),
    countries: Array.from(new Set(rows.map((r) => r.country).filter(Boolean))).sort(),
    zones: Array.from(new Set(rows.map((r) => r.zone).filter(Boolean))).sort(),
  }), [rows]);

  // ─── Apply filters ──────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (selCategory.length > 0 && !selCategory.includes(row.category)) return false;
      if (selYear.length > 0 && !selYear.includes(row.year)) return false;
      if (selMonth.length > 0 && !selMonth.some((m) => normalizeMonth(m) === normalizeMonth(row.month))) return false;
      if (selParentSupplier.length > 0 && !selParentSupplier.includes(row.parentSupplier)) return false;
      if (selSupplier.length > 0 && !selSupplier.includes(row.supplier)) return false;
      if (selCountry.length > 0 && !selCountry.includes(row.country)) return false;
      if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
      return true;
    });
  }, [rows, selCategory, selYear, selMonth, selParentSupplier, selSupplier, selCountry, selZone]);

  // ─── Scoring ────────────────────────────────────────────────────────────
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;

  const inputAssessments = useMemo(() => validateRows(filteredRows), [filteredRows]);
  const inputAssessmentById = useMemo(
    () => new Map(inputAssessments.map((a) => [a.id, a])),
    [inputAssessments],
  );

  const supplierScores = useMemo(
    () => (configIsValid ? scoreSupplierRows(filteredRows, config) : []),
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
  const categoryRollup = useMemo(
    () => (configIsValid ? calculateCategoryRollup(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );

  // ─── Config helpers ─────────────────────────────────────────────────────
  const updateNumericConfig = (field: "maxScore" | "criticalFloor" | "target", value: string, scale = 1) => {
    setConfig((c) => ({ ...c, [field]: value === "" ? Number.NaN : Number(value) / scale }));
  };

  const updateRow = (id: string, field: keyof SupplierKpiInputRow, value: SupplierKpiInputRow[keyof SupplierKpiInputRow]) => {
    setRows((cur) => cur.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const addRow = () => setRows((cur) => [...cur, emptyRow(`manual-${Date.now()}`)]);
  const removeRow = (id: string) => setRows((cur) => cur.filter((r) => r.id !== id));

  const exportResults = () => {
    const csv = toCsv([
      ["DOT Config"], ["Max Score", config.maxScore], ["Floor %", percent(config.criticalFloor, 2)], ["Target %", percent(config.target, 2)], ["Rows", filteredRows.length], [],
      ["Supplier Level"],
      ["Supplier", "Parent", "Zone", "Country", "Category", "DOT %", "Rank", "Percentile", "Attainment", "Max", "Earned", "Score %", "Status"],
      ...supplierScores.map((r) => [r.supplier, r.parentSupplier, r.zone, r.country, r.category, percent(r.normalizedDot, 2), formatRank(r.rankDescending), percent(r.percentile, 2), numeric(r.attainmentFactor, 4), numeric(r.maxScore, 2), numeric(r.earnedScore, 2), percent(r.scorePercent, 2), r.scoreStatus]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "dot-kpi-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Header */}
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Delivery KPI</p>
          <h1>DOT Percentile Scoring</h1>
          <p className="kpi-value-note">
            Value = On-Time PO Lines / (Total Delivered PO Lines + 0.99 &times; X1&nbsp;Delayed&nbsp;&gt;30d + 0.10 &times; X2&nbsp;Early&nbsp;&gt;30d)
          </p>
          {uploadMessage && <p className="supporting">{uploadMessage}</p>}
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh Data"}
          </button>
          <button type="button" onClick={exportResults} disabled={!configIsValid || filteredRows.length === 0}>
            Export Results
          </button>
        </div>
      </section>

      {/* Filters Row */}
      <section className="config-bar">
        <MultiSelectDropdown label="Category" options={opts.categories} selected={selCategory} onChange={setSelCategory} />
        <MultiSelectDropdown label="Year" options={opts.years} selected={selYear} onChange={setSelYear} />
        <MultiSelectDropdown label="Month" options={opts.months} selected={selMonth} onChange={setSelMonth} />
        <MultiSelectDropdown label="Parent Supplier" options={opts.parentSuppliers} selected={selParentSupplier} onChange={setSelParentSupplier} searchable />
        <MultiSelectDropdown label="Supplier" options={opts.suppliers} selected={selSupplier} onChange={setSelSupplier} searchable />
        <MultiSelectDropdown label="Zone" options={opts.zones} selected={selZone} onChange={setSelZone} />
        <MultiSelectDropdown label="Country" options={opts.countries} selected={selCountry} onChange={setSelCountry} />
        <div className="filter-summary">
          <strong>{filteredRows.length}</strong> / {rows.length} rows
        </div>
      </section>

      {/* Configuration Row */}
      <section className="config-bar">
        <label>
          <span>Max Score</span>
          <input type="number" min="0" step="0.5" value={Number.isFinite(config.maxScore) ? config.maxScore : ""} onChange={(e) => updateNumericConfig("maxScore", e.target.value)} />
        </label>
        <label>
          <span>Critical Floor %</span>
          <input type="number" min="0" max="100" step="0.1" value={Number.isFinite(config.criticalFloor) ? Number((config.criticalFloor * 100).toFixed(4)) : ""} onChange={(e) => updateNumericConfig("criticalFloor", e.target.value, 100)} />
        </label>
        <label>
          <span>Target %</span>
          <input type="number" min="0" max="100" step="0.1" value={Number.isFinite(config.target) ? Number((config.target * 100).toFixed(4)) : ""} onChange={(e) => updateNumericConfig("target", e.target.value, 100)} />
        </label>
        <label>
          <span>Formula Mode</span>
          <select value={config.formulaMode} onChange={(e) => setConfig((c) => ({ ...c, formulaMode: e.target.value as "softStretch" | "strict" }))}>
            <option value="softStretch">Softer Percentile Stretch</option>
            <option value="strict">Strict Percentile &times; Attainment</option>
          </select>
        </label>
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
                : "No data. Click Refresh Data or Upload CSV."}
            </p>
          </div>
          <div className="table-actions">
            <button type="button" onClick={() => fileInputRef.current?.click()}>Upload CSV</button>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={handleCsvUpload} />
          </div>
        </div>
      </section>

      {/* How DOT Earned Score is Calculated */}
      <details className="formula-panel collapsible-section" open>
        <summary>How DOT Earned Score Is Calculated</summary>
        <div className="formula-ribbon" aria-label="DOT formula summary">
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
            <strong>(DOT &minus; Critical Floor) / (Target &minus; Critical Floor), clamped 0&ndash;1</strong>
          </div>
          <div>
            <span>3. Percentile</span>
            <strong>(N &minus; Rank) / (N &minus; 1). Rank 1 = best = 100th percentile.</strong>
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
            <li><strong>Raw DOT values are preferred.</strong> DOT % Override is used only when raw PO-line fields are not available.</li>
            <li><strong>Rank valid suppliers within the cohort.</strong> Rank 1 is best. Percentile = (N − Rank) / (N − 1).</li>
            <li><strong>Attainment = (DOT − Critical Floor) / (Target − Critical Floor).</strong> Capped 0–1. Below floor = 0.</li>
            <li><strong>Softer Stretch:</strong> Max × Attainment × (0.7 + 0.3 × Percentile). Even the lowest-ranked supplier keeps 70% of attainment value.</li>
            <li><strong>Strict:</strong> Max × Percentile × Attainment. Rank matters fully — last place gets near-zero.</li>
            <li><strong>Not Applicable and invalid DOT rows are excluded.</strong> They are not treated as zero performance.</li>
          </ul>
        </details>
      </details>

      {/* Why This Method Is Needed */}
      <details className="formula-panel collapsible-section" open>
        <summary>Why This Method Is Needed</summary>
        <ol>
          <li>Threshold scoring can hide differences between suppliers that are both above or below the same bucket.</li>
          <li>Pure percentile can reward weak performance when every supplier in the cohort is weak.</li>
          <li>The attainment gate prevents below-floor DOT from receiving score just because it ranks well.</li>
          <li>Raw PO-line aggregation keeps high-volume and low-volume suppliers from being averaged incorrectly in rollups.</li>
          <li>Every score traces back to DOT, percentile, floor, target, attainment, and earned score.</li>
        </ol>
      </details>

      {/* Results (scrollable rollups) */}
      <section className="results-panel">
        <h2>Calculation Results</h2>
        {filteredRows.length === 0 ? (
          <div className="empty-state">No data matches filters.</div>
        ) : !configIsValid ? (
          <div className="empty-state">Fix configuration errors.</div>
        ) : (
          <div className="calculation-stack">
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">1</span><h3>Supplier Level ({supplierScores.length} rows{supplierScores.length > 200 ? ", showing first 200" : ""})</h3></summary>
              <div className="rollup-scroll"><SupplierResults rows={supplierScores.slice(0, 200)} /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">2</span><h3>Zone Rollup</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={zoneRollup} label="Zone" /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">3</span><h3>Parent Rollup</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={parentRollup} label="Parent Supplier" /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">4</span><h3>Category Rollup</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={categoryRollup} label="Category" /></div>
            </details>
          </div>
        )}
      </section>
    </>
  );
}

// ─── Result Tables ──────────────────────────────────────────────────────────

function SupplierResults({ rows }: { rows: ScoredKpiRow[] }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>Supplier</th><th>Parent</th><th>Zone</th><th>Country</th><th>Category</th>
          <th>On-Time</th><th>Tot. Del.</th><th>X1 Late</th><th>X2 Early</th>
          <th>DOT %</th><th>Rank</th><th>Percentile</th><th>Attainment</th>
          <th>Max</th><th>Earned</th><th>Score %</th><th>Status</th><th>Explanation</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{displayText(row.supplier, `Row ${row.rowNumber}`)}</td>
              <td>{displayText(row.parentSupplier, "")}</td>
              <td>{displayText(row.zone, "")}</td>
              <td>{displayText(row.country, "")}</td>
              <td>{displayText(row.category, "")}</td>
              <td>{rawInt(row.rawValues?.onTimePoLines)}</td>
              <td>{rawInt(row.rawValues?.totalDeliveredPoLines)}</td>
              <td>{rawInt(row.rawValues?.x1DelayedOver30Days)}</td>
              <td>{rawInt(row.rawValues?.x2EarlyOver30Days)}</td>
              <td>{percent(row.normalizedDot, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td>
              <td className="explanation-cell">{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RollupResults({ rows, label }: { rows: RollupRow[]; label: string }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>{label}</th>
          <th>On-Time</th><th>Tot. Del.</th><th>X1 Late</th><th>X2 Early</th>
          <th>DOT %</th><th>Rank</th><th>Percentile</th>
          <th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th>
          <th>Status</th><th>Rows</th><th>Explanation</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{row.label}</td>
              <td>{rawInt(row.onTimePoLines)}</td>
              <td>{rawInt(row.totalDeliveredPoLines)}</td>
              <td>{rawInt(row.x1DelayedOver30Days)}</td>
              <td>{rawInt(row.x2EarlyOver30Days)}</td>
              <td>{percent(row.normalizedDot, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td>
              <td>{row.contributingRows}</td>
              <td className="explanation-cell">{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const rowClass = (status: string) => {
  if (status === "Invalid DOT") return "invalid-row";
  if (status === "Not applicable") return "not-applicable-row";
  return "";
};

const statusClass = (status: string) => {
  if (status === "Invalid DOT") return "status-invalid";
  if (status === "Not applicable") return "status-na";
  if (status === "Below critical floor" || status === "Zero DOT") return "status-floor";
  if (status === "No variance" || status === "Single observation") return "status-note";
  return "status-valid";
};

export default DotKpiPage;
