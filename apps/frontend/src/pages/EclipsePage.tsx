// ---------------------------------------------------------------------------
// Eclipse Score KPI Page
// Same layout / formulas as IOT / Supplier Maturity, but:
//   - Value is Eclipse Score (0-100 combined pillar score)
//   - Defaults: Max Score = 5, Floor = 50%, Target = 80%
//   - No month filter (year is constant "2025")
//   - Rollups: Supplier + Zone + Parent + Category
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { MultiSelectDropdown } from "../shared/MultiSelectDropdown";
import { ApplyScorecardButton } from "../shared/ApplyScorecardButton";
import { usePersistedState } from "../shared/usePersistedState";
import {
  calculateAttainmentFactor,
  calculateEarnedScore,
  calculatePercentileRanks,
  validateConfig,
} from "../shared/scoring";
import { toCsv } from "../shared/csv";
import type { KpiConfig } from "../shared/types";

// ─── Eclipse Types ──────────────────────────────────────────────────────────

interface EclipseInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  category: string;
  kpiApplicability: string;
  eclipseScore: string;
  year: string;
}

interface EclipseScoredRow extends EclipseInputRow {
  eclipseNorm: number | null;
  rank: number | null;
  percentile: number | null;
  attainment: number | null;
  earnedScore: number | null;
  scorePercent: number | null;
  status: string;
  explanation: string;
}

interface EclipseRollupRow {
  id: string;
  label: string;
  eclipseNorm: number | null;
  rank: number | null;
  percentile: number | null;
  attainment: number | null;
  earnedScore: number | null;
  scorePercent: number | null;
  status: string;
  explanation: string;
  contributingRows: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const percent = (v: number | null, d = 1) =>
  v === null || !Number.isFinite(v) ? "-" : `${(v * 100).toFixed(d)}%`;

const numeric = (v: number | null, d = 2) =>
  v === null || !Number.isFinite(v) ? "-" : v.toFixed(d);

const formatRank = (v: number | null) =>
  v === null || !Number.isFinite(v) ? "-" : String(Math.floor(v));

// ─── Multi-select dropdown ──────────────────────────────────────────────────

// ─── Eclipse Scoring ────────────────────────────────────────────────────────

function scoreEclipseRows(rows: EclipseInputRow[], config: KpiConfig): EclipseScoredRow[] {
  // eclipseScore is already normalized to 0-1 from backend
  const assessed = rows.map((row) => {
    const isApplicable = row.kpiApplicability !== "Not Applicable";
    const raw = parseFloat(row.eclipseScore);
    const eclipseNorm = isApplicable && Number.isFinite(raw) ? raw : null;
    return { ...row, eclipseNorm, isApplicable };
  });

  // Get valid rows for ranking
  const validRows = assessed
    .filter((r) => r.isApplicable && r.eclipseNorm !== null)
    .map((r) => ({ id: r.id, dot: r.eclipseNorm as number }));

  const ranks = calculatePercentileRanks(validRows, config.target);

  return assessed.map((row) => {
    if (!row.isApplicable) {
      return { ...row, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Not Applicable", explanation: "Not applicable: excluded from ranking and scoring." };
    }
    if (row.eclipseNorm === null) {
      return { ...row, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Missing Data", explanation: "Missing data: no valid Eclipse Score available." };
    }

    const rankInfo = ranks.get(row.id);
    const percentile = rankInfo?.percentile ?? null;
    const attainment = calculateAttainmentFactor(row.eclipseNorm, config.criticalFloor, config.target);
    const earnedScore = percentile !== null
      ? calculateEarnedScore(config.maxScore, percentile, attainment, config.formulaMode)
      : null;

    let status = "Valid score";
    if (row.eclipseNorm <= config.criticalFloor) status = "Below critical floor";
    else if (row.eclipseNorm === 0) status = "Zero Eclipse";

    const explanation = status === "Below critical floor"
      ? `Below critical floor: Eclipse ${(row.eclipseNorm * 100).toFixed(2)}% ≤ floor ${(config.criticalFloor * 100).toFixed(2)}%. Attainment = 0, earned score = 0.`
      : config.formulaMode === "softStretch"
        ? `Valid score: Eclipse ${(row.eclipseNorm * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned Score = ${config.maxScore} × ${attainment.toFixed(4)} × (70% + 30% × ${percentile !== null ? (percentile * 100).toFixed(2) : 0}%) = ${earnedScore?.toFixed(2) ?? 0}.`
        : `Valid score: Eclipse ${(row.eclipseNorm * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned Score = ${config.maxScore} × ${percentile !== null ? (percentile * 100).toFixed(2) : 0}% × ${attainment.toFixed(4)} = ${earnedScore?.toFixed(2) ?? 0}.`;

    return {
      ...row,
      rank: rankInfo?.rank ?? null,
      percentile,
      attainment,
      earnedScore,
      scorePercent: earnedScore !== null ? earnedScore / config.maxScore : null,
      status,
      explanation,
    };
  });
}

function calculateEclipseRollup(
  rows: EclipseInputRow[],
  config: KpiConfig,
  groupBy: "supplier" | "zone" | "parentSupplier" | "category",
): EclipseRollupRow[] {
  // Group and average
  const groups = new Map<string, { sum: number; count: number }>();
  rows.forEach((row) => {
    if (row.kpiApplicability === "Not Applicable") return;
    const raw = parseFloat(row.eclipseScore);
    if (!Number.isFinite(raw)) return;
    const key = groupBy === "parentSupplier"
      ? (row.parentSupplier?.trim() || "Unassigned parent")
      : (row[groupBy]?.trim() || "Unassigned");
    const existing = groups.get(key) || { sum: 0, count: 0 };
    existing.sum += raw;
    existing.count += 1;
    groups.set(key, existing);
  });

  // Calculate average Eclipse score per group
  const seeds = Array.from(groups.entries()).map(([label, g], i) => ({
    id: `rollup-${groupBy}-${i}`,
    label,
    eclipseNorm: g.count > 0 ? g.sum / g.count : null,
    contributingRows: g.count,
  }));

  // Rank
  const validSeeds = seeds.filter((s) => s.eclipseNorm !== null);
  const ranks = calculatePercentileRanks(
    validSeeds.map((s) => ({ id: s.id, dot: s.eclipseNorm as number })),
    config.target,
  );

  return seeds.map((seed) => {
    if (seed.eclipseNorm === null) {
      return { ...seed, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Missing Data", explanation: "No valid data for this group." };
    }
    const rankInfo = ranks.get(seed.id);
    const percentile = rankInfo?.percentile ?? null;
    const attainment = calculateAttainmentFactor(seed.eclipseNorm, config.criticalFloor, config.target);
    const earnedScore = percentile !== null
      ? calculateEarnedScore(config.maxScore, percentile, attainment, config.formulaMode)
      : null;
    let status = "Valid score";
    if (seed.eclipseNorm <= config.criticalFloor) status = "Below critical floor";

    const explanation = status === "Below critical floor"
      ? `Below critical floor: Eclipse ${(seed.eclipseNorm * 100).toFixed(2)}% ≤ floor ${(config.criticalFloor * 100).toFixed(2)}%. Earned score = 0.`
      : `Valid score: Eclipse ${(seed.eclipseNorm * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned = ${earnedScore?.toFixed(2) ?? 0}. Rollup of ${seed.contributingRows} rows.`;

    return {
      ...seed,
      rank: rankInfo?.rank ?? null,
      percentile,
      attainment,
      earnedScore,
      scorePercent: earnedScore !== null ? earnedScore / config.maxScore : null,
      status,
      explanation,
    };
  });
}

// ─── Main Page ──────────────────────────────────────────────────────────────

interface EclipsePageProps { sharedParent: string[]; onParentChange: (v: string[]) => void; }

function EclipsePage({ sharedParent: selParentSupplier, onParentChange: setSelParentSupplier }: EclipsePageProps) {
  const [rows, setRows] = useState<EclipseInputRow[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [config, setConfig] = usePersistedState<KpiConfig>('kpi-ecl-config', {
    maxScore: 5,
    criticalFloor: 0.5,
    target: 0.8,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });

  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>(["2025", "2026"]);
  // selParentSupplier / setSelParentSupplier provided via sharedParent prop from App
  const [selSupplier, setSelSupplier] = useState<string[]>([]);
  const [selZone, setSelZone] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

  const loadFromApi = () => {
    fetch(`${API_BASE}/api/eclipse`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data && json.data.length > 0) {
          const parsed: EclipseInputRow[] = json.data.map(
            (row: Record<string, string>, i: number) => ({
              id: row.id || `ecl-${i}`,
              supplier: row.supplier || "",
              parentSupplier: row.parentSupplier || "",
              zone: row.zone || "",
              category: row.category || "",
              kpiApplicability: row.kpiApplicability || "Applicable",
              eclipseScore: row.eclipseScore || "",
              year: row.year || "",
            }),
          );
          setRows(parsed);
          setUploadMessage(`${parsed.length} rows loaded.`);
        } else {
          setUploadMessage("No cached Eclipse data. Upload a CSV to load data.");
        }
      })
      .catch(() => setUploadMessage("Backend not running. Start it with run.bat."));
  };

  useEffect(() => { loadFromApi(); }, []);

  // Dynamic filter options
  const opts = useMemo(() => ({
    categories: Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort(),
    years: ["2025", "2026"],
    parentSuppliers: Array.from(new Set(rows.map((r) => r.parentSupplier).filter(Boolean))).sort(),
    suppliers: Array.from(new Set(rows.map((r) => r.supplier).filter(Boolean))).sort(),
    zones: Array.from(new Set(rows.map((r) => r.zone).filter(Boolean))).sort(),
  }), [rows]);

  // Apply filters
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (selCategory.length > 0 && !selCategory.includes(row.category)) return false;
      if (selYear.length > 0 && !selYear.includes(row.year)) return false;
      if (selParentSupplier.length > 0 && !selParentSupplier.includes(row.parentSupplier)) return false;
      if (selSupplier.length > 0 && !selSupplier.includes(row.supplier)) return false;
      if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
      return true;
    });
  }, [rows, selCategory, selYear, selParentSupplier, selSupplier, selZone]);

  // contextRows excludes parent/supplier filters so percentile ranks match the
  // Normalized Scorecard backend (global/zone-contextual population).
  const contextRows = useMemo(() => {
    return rows.filter((row) => {
      if (selCategory.length > 0 && !selCategory.includes(row.category)) return false;
      if (selYear.length > 0 && !selYear.includes(row.year)) return false;
      if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
      return true;
    });
  }, [rows, selCategory, selYear, selZone]);

  // Scoring
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;

  const scoredRows = useMemo(
    () => (configIsValid ? scoreEclipseRows(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );

  const supplierRollup = useMemo(
    () => (configIsValid ? calculateEclipseRollup(filteredRows, config, "supplier") : []),
    [filteredRows, config, configIsValid],
  );
  const zoneRollup = useMemo(
    () => (configIsValid ? calculateEclipseRollup(filteredRows, config, "zone") : []),
    [filteredRows, config, configIsValid],
  );
  const parentRollup = useMemo(
    () => (configIsValid ? calculateEclipseRollup(contextRows, config, "parentSupplier") : []),
    [contextRows, config, configIsValid],
  );
  const displayedParentRollup = useMemo(
    () => selParentSupplier.length > 0
      ? parentRollup.filter((r) => selParentSupplier.includes(r.label))
      : parentRollup,
    [parentRollup, selParentSupplier],
  );
  const categoryRollup = useMemo(
    () => (configIsValid ? calculateEclipseRollup(filteredRows, config, "category") : []),
    [filteredRows, config, configIsValid],
  );

  const updateNumericConfig = (field: "maxScore" | "criticalFloor" | "target", value: string, scale = 1) => {
    setConfig((c) => ({ ...c, [field]: value === "" ? Number.NaN : Number(value) / scale }));
  };

  const exportResults = () => {
    const csv = toCsv([
      ["Eclipse Score Config"], ["Max Score", config.maxScore], ["Floor %", percent(config.criticalFloor, 2)], ["Target %", percent(config.target, 2)], ["Rows", filteredRows.length], [],
      ["Supplier Level"],
      ["Supplier", "Parent", "Zone", "Category", "Eclipse %", "Rank", "Percentile", "Attainment", "Max", "Earned", "Score %", "Status"],
      ...scoredRows.map((r) => [r.supplier, r.parentSupplier, r.zone, r.category, percent(r.eclipseNorm, 2), formatRank(r.rank), percent(r.percentile, 2), numeric(r.attainment, 4), numeric(config.maxScore, 2), numeric(r.earnedScore, 2), percent(r.scorePercent, 2), r.status]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "eclipse-score-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Sustainability KPI</p>
          <h1>Eclipse Score</h1>
          <p className="kpi-value-note">
            Value = Eclipse Score (0-100 combined pillar score: Climate Action + Engagement + Reporting)
          </p>
          {uploadMessage && <p className="supporting">{uploadMessage}</p>}
        </div>
        <div className="header-actions">

          <button type="button" onClick={exportResults} disabled={!configIsValid || filteredRows.length === 0}>
            Export Results
          </button>
        </div>
      </section>

      {/* Filters */}
      <section className="config-bar">
        <MultiSelectDropdown label="Category" options={opts.categories} selected={selCategory} onChange={setSelCategory} />
        <MultiSelectDropdown label="Year" options={opts.years} selected={selYear} onChange={setSelYear} />
        <MultiSelectDropdown label="Parent Supplier" options={opts.parentSuppliers} selected={selParentSupplier} onChange={setSelParentSupplier} searchable />
        <MultiSelectDropdown label="Supplier" options={opts.suppliers} selected={selSupplier} onChange={setSelSupplier} searchable />
        <MultiSelectDropdown label="Zone" options={opts.zones} selected={selZone} onChange={setSelZone} />
        <div className="filter-summary"><strong>{filteredRows.length}</strong> / {rows.length} rows</div>
      </section>

      {/* Configuration */}
      <section className="config-bar">
        <label><span>Max Score</span><input type="number" min="0" step="0.5" value={Number.isFinite(config.maxScore) ? config.maxScore : ""} onChange={(e) => updateNumericConfig("maxScore", e.target.value)} /></label>
        <label><span>Critical Floor %</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(config.criticalFloor) ? Number((config.criticalFloor * 100).toFixed(4)) : ""} onChange={(e) => updateNumericConfig("criticalFloor", e.target.value, 100)} /></label>
        <label><span>Target %</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(config.target) ? Number((config.target * 100).toFixed(4)) : ""} onChange={(e) => updateNumericConfig("target", e.target.value, 100)} /></label>
        <label><span>Formula Mode</span>
          <select value={config.formulaMode} onChange={(e) => setConfig((c) => ({ ...c, formulaMode: e.target.value as "softStretch" | "strict" }))}>
            <option value="softStretch">Softer Percentile Stretch</option>
            <option value="strict">Strict Percentile &times; Attainment</option>
          </select>
        </label>
        {configErrors.length > 0 && <div className="validation-box config-bar-errors">{configErrors.map((e) => <p key={e}>{e}</p>)}</div>}
        <ApplyScorecardButton kpiId="ECL" floor={config.criticalFloor} target={config.target} maxScore={config.maxScore} apiBase={API_BASE} />
      </section>

      {/* Data Summary */}
      <section className="input-panel">
        <div className="panel-heading">
          <h2>Data Summary</h2>
          <p className="supporting">
            {rows.length > 0 ? `${rows.length} total rows. Showing ${filteredRows.length} after filters.` : "No data."}
          </p>
        </div>
      </section>

      {/* Formula */}
      <details className="formula-panel collapsible-section" open>
        <summary>How Eclipse Earned Score Is Calculated</summary>
        <div className="formula-ribbon">
          <div><span>1. Eclipse Score</span><strong>Pre-normalised 0&ndash;1 from backend (original 0-100 scale)</strong></div>
          <div><span>2. Attainment</span><strong>(Eclipse Score &minus; Floor) / (Target &minus; Floor), clamped 0&ndash;1</strong></div>
          <div><span>3. Percentile</span><strong>(N &minus; Rank) / (N &minus; 1)</strong></div>
        </div>
        <div className="formula-callout">
          <strong>Earned Score:</strong>{" "}
          {config.formulaMode === "softStretch"
            ? "Max Score × Attainment × (70% + 30% × Percentile)"
            : "Max Score × Percentile × Attainment"}
        </div>
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
                <h3>Supplier Level ({scoredRows.length} rows{scoredRows.length > 200 ? ", showing first 200" : ""})</h3>
              </summary>
              <div className="rollup-scroll">
                <div className="table-frame">
                  <table className="data-table results-table">
                    <thead><tr>
                      <th>Supplier</th><th>Parent</th><th>Zone</th><th>Category</th>
                      <th>Eclipse %</th><th>Rank</th><th>Percentile</th><th>Attainment</th>
                      <th>Max</th><th>Earned</th><th>Score %</th><th>Status</th><th>Explanation</th>
                    </tr></thead>
                    <tbody>
                      {scoredRows.slice(0, 200).map((row) => (
                        <tr key={row.id} className={row.status === "Below critical floor" ? "invalid-row" : row.status === "Not Applicable" ? "not-applicable-row" : ""}>
                          <td>{row.supplier}</td>
                          <td>{row.parentSupplier}</td>
                          <td>{row.zone}</td>
                          <td>{row.category}</td>
                          <td>{percent(row.eclipseNorm, 2)}</td>
                          <td>{formatRank(row.rank)}</td>
                          <td>{percent(row.percentile, 2)}</td>
                          <td>{numeric(row.attainment, 4)}</td>
                          <td>{numeric(config.maxScore, 2)}</td>
                          <td>{numeric(row.earnedScore, 2)}</td>
                          <td>{percent(row.scorePercent, 2)}</td>
                          <td><span className={`status-pill ${row.status === "Valid score" ? "status-valid" : row.status === "Below critical floor" ? "status-floor" : "status-na"}`}>{row.status}</span></td>
                          <td className="explanation-cell">{row.explanation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">2</span><h3>Zone Rollup</h3></summary>
              <div className="rollup-scroll"><RollupTable rows={zoneRollup} label="Zone" maxScore={config.maxScore} /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">3</span><h3>Parent Supplier Rollup</h3></summary>
              <div className="rollup-scroll"><RollupTable rows={displayedParentRollup} label="Parent Supplier" maxScore={config.maxScore} /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">4</span><h3>Category Rollup</h3></summary>
              <div className="rollup-scroll"><RollupTable rows={categoryRollup} label="Category" maxScore={config.maxScore} /></div>
            </details>
          </div>
        )}
      </section>
    </>
  );
}

function RollupTable({ rows, label, maxScore }: { rows: EclipseRollupRow[]; label: string; maxScore: number }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>{label}</th><th>Eclipse %</th><th>Rank</th><th>Percentile</th>
          <th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th>
          <th>Status</th><th>Rows</th><th>Explanation</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.status === "Below critical floor" ? "invalid-row" : ""}>
              <td>{row.label}</td>
              <td>{percent(row.eclipseNorm, 2)}</td>
              <td>{formatRank(row.rank)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainment, 4)}</td>
              <td>{numeric(maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td><span className={`status-pill ${row.status === "Valid score" ? "status-valid" : row.status === "Below critical floor" ? "status-floor" : "status-na"}`}>{row.status}</span></td>
              <td>{row.contributingRows}</td>
              <td className="explanation-cell">{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default EclipsePage;
