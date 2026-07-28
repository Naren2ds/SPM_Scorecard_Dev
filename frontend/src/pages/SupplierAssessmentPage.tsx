// ---------------------------------------------------------------------------
// Supplier Assessment (Quality) KPI Page
// Mirrors DotKpiPage exactly: API-backed data + refresh button, multi-select
// filter bar, configuration bar, hierarchical rollup tables.
// Only the scoring math differs (see supplierAssessmentScoring.ts, which
// implements docs/Support_Docs/supplier-assessment-percentile-scoring.md).
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { MultiSelectDropdown } from "../shared/MultiSelectDropdown";
import {
  calculateCategoryRollup,
  calculateCountryRollup,
  calculateParentRollup,
  calculateSupplierScores,
  calculateZoneRollup,
  formulaModeLabel,
  toCsv,
  validateConfig,
} from "../features/supplier-assessment/scoring";
import type {
  AssessmentConfig,
  AssessmentFormulaMode,
  RollupAssessmentRow,
  ScoredAssessmentRow,
  SupplierAssessmentInputRow,
} from "../features/supplier-assessment/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value)
    ? "-"
    : `${(value * 100).toFixed(digits)}%`;

const numeric = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);

const formatRank = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "-" : String(Math.floor(value));

const displayText = (value: string, fallback: string) =>
  (value ?? "").trim() || fallback;

// ─── Main Page ─────────────────────────────────────────────────────────────

const API_BASE = "http://127.0.0.1:8000";

function SupplierAssessmentPage() {
  const [rows, setRows] = useState<SupplierAssessmentInputRow[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [config, setConfig] = useState<AssessmentConfig>({
    maxScore: 10,
    greenWeight: 1,
    yellowWeight: 0.5,
    redWeight: 0,
    criticalFloor: 0.5,
    target: 0.8,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
    redWarningThreshold: 0.05,
    redCapThreshold: 0.1,
    capScoreIfRedExceedsThreshold: false,
  });

  // Multi-select filter states (empty = All). Year defaults to "2026".
  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>(["2025", "2026"]);
  const [selParent, setSelParent] = useState<string[]>([]);
  const [selSupplier, setSelSupplier] = useState<string[]>([]);
  const [selZone, setSelZone] = useState<string[]>([]);
  const [selCountry, setSelCountry] = useState<string[]>([]);

  // ─── Load cached data from API on mount ─────────────────────────────────
  const loadFromApi = () => {
    fetch(`${API_BASE}/api/supplier-assessment`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data && json.data.length > 0) {
          const parsed: SupplierAssessmentInputRow[] = json.data.map(
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
              supplierApprovalStatus: row.supplierApprovalStatus || "",
              greenCount: row.greenCount || "",
              yellowCount: row.yellowCount || "",
              redCount: row.redCount || "",
              naCount: row.naCount || "",
              blankCount: row.blankCount || "",
              year: row.year || "",
            }),
          );
          setRows(parsed);
          setStatusMessage(`${parsed.length} rows loaded.`);
        } else {
          setStatusMessage(
            "No cached Supplier Assessment data. Click Refresh Data to fetch from Databricks.",
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
    fetch(`${API_BASE}/api/supplier-assessment/refresh`, { method: "POST" })
      .then(() => {
        const poll = setInterval(() => {
          fetch(`${API_BASE}/api/status`)
            .then((res) => res.json())
            .then((json) => {
              if (json.sa_status !== "refreshing") {
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
      years: ["2025", "2026"],
      parents: Array.from(
        new Set(rows.map((r) => r.parentSupplier).filter(Boolean)),
      ).sort(),
      suppliers: Array.from(
        new Set(rows.map((r) => r.supplier).filter(Boolean)),
      ).sort(),
      zones: Array.from(new Set(rows.map((r) => r.zone).filter(Boolean))).sort(),
      countries: Array.from(
        new Set(rows.map((r) => r.country).filter(Boolean)),
      ).sort(),
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
        if (selCountry.length > 0 && !selCountry.includes(row.country))
          return false;
        return true;
      }),
    [rows, selCategory, selYear, selParent, selSupplier, selZone, selCountry],
  );

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
    () => (configIsValid ? calculateParentRollup(contextRows, config) : []),
    [contextRows, config, configIsValid],
  );
  const displayedParentRollup = useMemo(
    () => selParent.length > 0
      ? parentRollup.filter((r) => selParent.includes(r.parentSupplier))
      : parentRollup,
    [parentRollup, selParent],
  );
  const categoryRollup = useMemo(
    () => (configIsValid ? calculateCategoryRollup(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );
  const countryRollup = useMemo(
    () => (configIsValid ? calculateCountryRollup(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );

  // ─── Config helpers ─────────────────────────────────────────────────────
  const updateNumericConfig = (
    field:
      | "maxScore"
      | "greenWeight"
      | "yellowWeight"
      | "redWeight"
      | "criticalFloor"
      | "target"
      | "redWarningThreshold"
      | "redCapThreshold",
    value: string,
    scale = 1,
  ) => {
    setConfig((c) => ({
      ...c,
      [field]: value === "" ? Number.NaN : Number(value) / scale,
    }));
  };

  // ─── Export ─────────────────────────────────────────────────────────────
  const exportResults = () => {
    const csv = toCsv([
      ["Supplier Assessment Config"],
      ["Max Score", config.maxScore],
      ["Green / Yellow / Red Weights", `${config.greenWeight} / ${config.yellowWeight} / ${config.redWeight}`],
      ["Critical Floor %", percent(config.criticalFloor, 2)],
      ["Target %", percent(config.target, 2)],
      ["Formula", formulaModeLabel(config.formulaMode)],
      ["Cap Score If Red % ≥ Threshold", config.capScoreIfRedExceedsThreshold ? `Yes (@ ${percent(config.redCapThreshold, 2)})` : "No"],
      ["Rows (after filters)", filteredRows.length],
      [],
      ["Supplier Level"],
      ["Supplier", "Parent", "Zone", "Country", "Category", "Approval Status", "Green", "Yellow", "Red", "N/A", "Valid", "Health %", "Rank", "Percentile %", "Attainment", "Max", "Earned", "Score %", "Status"],
      ...supplierScores.map((r) => [r.supplier, r.parentSupplier, r.zone, r.country, r.category, r.supplierApprovalStatus, r.greenCount, r.yellowCount, r.redCount, r.naCount, r.totalValidAssessments, percent(r.assessmentHealthIndex, 2), formatRank(r.rankDescending), percent(r.percentile, 2), numeric(r.attainmentFactor, 4), numeric(r.maxScore, 2), numeric(r.earnedScore, 2), percent(r.scorePercent, 2), r.scoreStatus]),
      [],
      ["Zone Rollup"],
      ...rollupExportRows(zoneRollup, "Zone"),
      [],
      ["Parent Rollup"],
      ...rollupExportRows(displayedParentRollup, "Parent Supplier"),
      [],
      ["Category Rollup"],
      ...rollupExportRows(categoryRollup, "Category"),
      [],
      ["Country Rollup"],
      ...rollupExportRows(countryRollup, "Country"),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "supplier-assessment-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Header */}
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Quality KPI</p>
          <h1>Supplier Assessment — Percentile Scoring</h1>
          <p className="kpi-value-note">
            Health Index = (Green × w<sub>G</sub> + Yellow × w<sub>Y</sub> + Red × w<sub>R</sub>) / Total Valid Assessments
          </p>
          {statusMessage && <p className="supporting">{statusMessage}</p>}
        </div>
        <div className="header-actions">

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
        <MultiSelectDropdown label="Parent Supplier" options={opts.parents} selected={selParent} onChange={setSelParent} searchable />
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
          <span>Green Weight</span>
          <input type="number" min="0" max="1" step="0.05" value={Number.isFinite(config.greenWeight) ? config.greenWeight : ""} onChange={(e) => updateNumericConfig("greenWeight", e.target.value)} />
        </label>
        <label>
          <span>Yellow Weight</span>
          <input type="number" min="0" max="1" step="0.05" value={Number.isFinite(config.yellowWeight) ? config.yellowWeight : ""} onChange={(e) => updateNumericConfig("yellowWeight", e.target.value)} />
        </label>
        <label>
          <span>Red Weight</span>
          <input type="number" min="0" max="1" step="0.05" value={Number.isFinite(config.redWeight) ? config.redWeight : ""} onChange={(e) => updateNumericConfig("redWeight", e.target.value)} />
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
          <select value={config.formulaMode} onChange={(e) => setConfig((c) => ({ ...c, formulaMode: e.target.value as AssessmentFormulaMode }))}>
            <option value="softStretch">Softer Percentile Stretch</option>
            <option value="strict">Strict Percentile &times; Attainment</option>
          </select>
        </label>
        <label>
          <span>Cap @ Red %</span>
          <input type="number" min="0" max="100" step="0.1" value={Number.isFinite(config.redCapThreshold) ? Number((config.redCapThreshold * 100).toFixed(4)) : ""} onChange={(e) => updateNumericConfig("redCapThreshold", e.target.value, 100)} />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.capScoreIfRedExceedsThreshold}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                capScoreIfRedExceedsThreshold: e.target.checked,
              }))
            }
          />
          <span>Enable Red Cap</span>
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
                : "No data. Click Refresh Data to fetch from Databricks."}
            </p>
          </div>
        </div>
      </section>

      {/* How Supplier Assessment Earned Score is Calculated */}
      <details className="formula-panel collapsible-section" open>
        <summary>How Supplier Assessment Earned Score Is Calculated</summary>
        <div className="formula-ribbon" aria-label="Supplier Assessment formula summary">
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
            <strong>(Health Index &minus; Floor) / (Target &minus; Floor), clamped 0&ndash;1</strong>
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
            <li><strong>Green / Yellow / Red are weighted into a Health Index.</strong> N/A and blank are excluded from the valid denominator.</li>
            <li><strong>Rank valid suppliers within the selected cohort.</strong> Highest Health Index = Rank 1 = strongest percentile.</li>
            <li><strong>Floor and Target apply to the Health Index.</strong> Below floor → Attainment = 0. Above target → Attainment = 1.</li>
            <li><strong>Softer formula protects 70% of the attainment-adjusted score</strong> even at 0th percentile — 30% is stretched by rank.</li>
            <li><strong>Optional Red Guardrail caps earned score at 50% of Max</strong> when Red % ≥ threshold.</li>
            <li><strong>Rollups aggregate counts first</strong>, then recalculate Health Index — never average supplier percentages.</li>
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
              <summary className="calculation-heading level-summary"><span className="level-badge">3</span><h3>Parent Rollup ({displayedParentRollup.length})</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={displayedParentRollup} label="Parent Supplier" /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">4</span><h3>Category Rollup ({categoryRollup.length})</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={categoryRollup} label="Category" /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">5</span><h3>Country Rollup ({countryRollup.length})</h3></summary>
              <div className="rollup-scroll"><RollupResults rows={countryRollup} label="Country" /></div>
            </details>
          </div>
        )}
      </section>
    </>
  );
}

// ─── Result Tables ─────────────────────────────────────────────────────────

function SupplierResults({ rows }: { rows: ScoredAssessmentRow[] }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>Supplier</th><th>Parent</th><th>Zone</th><th>Country</th><th>Category</th>
          <th>Approval Status</th>
          <th>Green</th><th>Yellow</th><th>Red</th><th>N/A</th><th>Valid</th>
          <th>Health %</th><th>Red %</th>
          <th>Rank</th><th>Percentile</th><th>Attainment</th>
          <th>Max</th><th>Earned</th><th>Score %</th><th>Status</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{displayText(row.supplier, "Unassigned")}</td>
              <td>{displayText(row.parentSupplier, "")}</td>
              <td>{displayText(row.zone, "")}</td>
              <td>{displayText(row.country, "")}</td>
              <td>{displayText(row.category, "")}</td>
              <td>{displayText(row.supplierApprovalStatus, "-")}</td>
              <td>{row.greenCount}</td>
              <td>{row.yellowCount}</td>
              <td>{row.redCount}</td>
              <td>{row.naCount}</td>
              <td>{row.totalValidAssessments}</td>
              <td>{percent(row.assessmentHealthIndex, 2)}</td>
              <td>{percent(row.redPercent, 2)}</td>
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
  rows: RollupAssessmentRow[];
  label: string;
}) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>{label}</th>
          <th>Green</th><th>Yellow</th><th>Red</th><th>N/A</th><th>Valid</th>
          <th>Health %</th><th>Red %</th>
          <th>Rank</th><th>Percentile</th><th>Attainment</th>
          <th>Max</th><th>Earned</th><th>Score %</th>
          <th>Contributing</th><th>Status</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{row.label}</td>
              <td>{row.greenCount}</td>
              <td>{row.yellowCount}</td>
              <td>{row.redCount}</td>
              <td>{row.naCount}</td>
              <td>{row.totalValidAssessments}</td>
              <td>{percent(row.assessmentHealthIndex, 2)}</td>
              <td>{percent(row.redPercent, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td>{row.contributingSuppliers}</td>
              <td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Export helper ─────────────────────────────────────────────────────────

const rollupExportRows = (rows: RollupAssessmentRow[], label: string) => [
  [label, "Green", "Yellow", "Red", "N/A", "Valid", "Health %", "Red %", "Rank", "Percentile %", "Attainment", "Max", "Earned", "Score %", "Contributing", "Status"],
  ...rows.map((r) => [
    r.label,
    r.greenCount,
    r.yellowCount,
    r.redCount,
    r.naCount,
    r.totalValidAssessments,
    percent(r.assessmentHealthIndex, 2),
    percent(r.redPercent, 2),
    formatRank(r.rankDescending),
    percent(r.percentile, 2),
    numeric(r.attainmentFactor, 4),
    numeric(r.maxScore, 2),
    numeric(r.earnedScore, 2),
    percent(r.scorePercent, 2),
    r.contributingSuppliers,
    r.scoreStatus,
  ]),
];

// ─── Status styling ────────────────────────────────────────────────────────

const rowClass = (status: string) => {
  if (
    status === "Not Applicable" ||
    status === "No Valid Assessment" ||
    status === "Missing Assessment"
  ) {
    return "not-applicable-row";
  }
  return "";
};

const statusClass = (status: string) => {
  if (
    status === "Not Applicable" ||
    status === "No Valid Assessment" ||
    status === "Missing Assessment"
  ) {
    return "status-na";
  }
  if (status === "Zero Score") return "status-floor";
  if (status === "No Variance" || status === "Single Observation") {
    return "status-note";
  }
  return "status-valid";
};

export default SupplierAssessmentPage;
