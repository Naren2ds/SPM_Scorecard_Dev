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

// ─── IOT Types ──────────────────────────────────────────────────────────────

interface IotInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  kpiApplicability: string;
  invoiceOnTimeCount: string;
  totalPoLines: string;
  year: string;
  month: string;
}

interface IotScoredRow extends IotInputRow {
  iotPercent: number | null;
  rank: number | null;
  percentile: number | null;
  attainment: number | null;
  earnedScore: number | null;
  scorePercent: number | null;
  status: string;
  explanation: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const percent = (v: number | null, d = 1) =>
  v === null || !Number.isFinite(v) ? "-" : `${(v * 100).toFixed(d)}%`;

const numeric = (v: number | null, d = 2) =>
  v === null || !Number.isFinite(v) ? "-" : v.toFixed(d);

const formatRank = (v: number | null) =>
  v === null || !Number.isFinite(v) ? "-" : String(Math.floor(v));

const rawInt = (v: number | null | undefined) =>
  v == null ? "-" : String(v);

const normalizeMonth = (m: string) => m.replace(/^0+/, "") || m;

// ─── Multi-select dropdown ──────────────────────────────────────────────────

// ─── IOT Scoring ────────────────────────────────────────────────────────────

interface IotRollupRow {
  id: string;
  label: string;
  iotPercent: number | null;
  invoiceOnTimeCount: number;
  totalPoLines: number;
  rank: number | null;
  percentile: number | null;
  attainment: number | null;
  earnedScore: number | null;
  scorePercent: number | null;
  status: string;
  explanation: string;
  contributingRows: number;
}

function scoreIotRows(rows: IotInputRow[], config: KpiConfig): IotScoredRow[] {
  // Calculate IOT% for each applicable row
  const assessed = rows.map((row) => {
    const onTime = Number(row.invoiceOnTimeCount) || 0;
    const total = Number(row.totalPoLines) || 0;
    const isApplicable = row.kpiApplicability !== "Not Applicable";
    const iotPercent = isApplicable && total > 0 ? onTime / total : null;
    return { ...row, iotPercent, isApplicable };
  });

  // Get valid rows for ranking
  const validRows = assessed
    .filter((r) => r.isApplicable && r.iotPercent !== null)
    .map((r) => ({ id: r.id, dot: r.iotPercent as number }));

  const ranks = calculatePercentileRanks(validRows, config.target);

  return assessed.map((row) => {
    if (!row.isApplicable) {
      return { ...row, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Not Applicable", explanation: "Not applicable: excluded from ranking and scoring." };
    }
    if (row.iotPercent === null) {
      return { ...row, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Missing Data", explanation: "Missing data: no valid PO lines available." };
    }

    const rankInfo = ranks.get(row.id);
    const percentile = rankInfo?.percentile ?? null;
    const attainment = calculateAttainmentFactor(row.iotPercent, config.criticalFloor, config.target);
    const earnedScore = percentile !== null
      ? calculateEarnedScore(config.maxScore, percentile, attainment, config.formulaMode)
      : null;

    let status = "Valid score";
    if (row.iotPercent <= config.criticalFloor) status = "Below critical floor";
    else if (row.iotPercent === 0) status = "Zero IOT";

    const explanation = status === "Below critical floor"
      ? `Below critical floor: IOT ${(row.iotPercent * 100).toFixed(2)}% ≤ floor ${(config.criticalFloor * 100).toFixed(2)}%. Attainment = 0, earned score = 0.`
      : config.formulaMode === "softStretch"
        ? `Valid score: IOT ${(row.iotPercent * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned Score = ${config.maxScore} × ${attainment.toFixed(4)} × (70% + 30% × ${percentile !== null ? (percentile * 100).toFixed(2) : 0}%) = ${earnedScore?.toFixed(2) ?? 0}.`
        : `Valid score: IOT ${(row.iotPercent * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned Score = ${config.maxScore} × ${percentile !== null ? (percentile * 100).toFixed(2) : 0}% × ${attainment.toFixed(4)} = ${earnedScore?.toFixed(2) ?? 0}.`;

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

function calculateIotRollup(
  rows: IotInputRow[],
  config: KpiConfig,
  groupBy: "zone" | "parentSupplier" | "category",
): IotRollupRow[] {
  // Group and sum
  const groups = new Map<string, { onTime: number; total: number; count: number }>();
  rows.forEach((row) => {
    if (row.kpiApplicability === "Not Applicable") return;
    const key = groupBy === "parentSupplier"
      ? (row.parentSupplier?.trim() || "Unassigned parent")
      : (row[groupBy]?.trim() || "Unassigned");
    const existing = groups.get(key) || { onTime: 0, total: 0, count: 0 };
    existing.onTime += Number(row.invoiceOnTimeCount) || 0;
    existing.total += Number(row.totalPoLines) || 0;
    existing.count += 1;
    groups.set(key, existing);
  });

  // Calculate IOT% per group
  const seeds = Array.from(groups.entries()).map(([label, g], i) => ({
    id: `rollup-${groupBy}-${i}`,
    label,
    iotPercent: g.total > 0 ? g.onTime / g.total : null,
    invoiceOnTimeCount: g.onTime,
    totalPoLines: g.total,
    contributingRows: g.count,
  }));

  // Rank
  const validSeeds = seeds.filter((s) => s.iotPercent !== null);
  const ranks = calculatePercentileRanks(
    validSeeds.map((s) => ({ id: s.id, dot: s.iotPercent as number })),
    config.target,
  );

  return seeds.map((seed) => {
    if (seed.iotPercent === null) {
      return { ...seed, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Missing Data", explanation: "No valid data for this group." };
    }
    const rankInfo = ranks.get(seed.id);
    const percentile = rankInfo?.percentile ?? null;
    const attainment = calculateAttainmentFactor(seed.iotPercent, config.criticalFloor, config.target);
    const earnedScore = percentile !== null
      ? calculateEarnedScore(config.maxScore, percentile, attainment, config.formulaMode)
      : null;
    let status = "Valid score";
    if (seed.iotPercent <= config.criticalFloor) status = "Below critical floor";

    const explanation = status === "Below critical floor"
      ? `Below critical floor: IOT ${(seed.iotPercent * 100).toFixed(2)}% ≤ floor ${(config.criticalFloor * 100).toFixed(2)}%. Earned score = 0.`
      : `Valid score: IOT ${(seed.iotPercent * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned = ${earnedScore?.toFixed(2) ?? 0}. Rollup of ${seed.contributingRows} rows.`;

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

interface IotKpiPageProps { sharedParent: string[]; onParentChange: (v: string[]) => void; }

function IotKpiPage({ sharedParent: selParentSupplier, onParentChange: setSelParentSupplier }: IotKpiPageProps) {
  const [rows, setRows] = useState<IotInputRow[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [config, setConfig] = usePersistedState<KpiConfig>('kpi-iot-config', {
    maxScore: 10,
    criticalFloor: 0.7,
    target: 0.85,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });

  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>(["2025", "2026"]);
  const [selMonth, setSelMonth] = useState<string[]>([]);
  // selParentSupplier / setSelParentSupplier provided via sharedParent prop from App
  const [selSupplier, setSelSupplier] = useState<string[]>([]);
  const [selCountry, setSelCountry] = useState<string[]>([]);
  const [selZone, setSelZone] = useState<string[]>([]);


  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

  const loadFromApi = () => {
    fetch(`${API_BASE}/api/iot-kpi`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data && json.data.length > 0) {
          const parsed: IotInputRow[] = json.data.map(
            (row: Record<string, string>, i: number) => ({
              id: row.id || `api-${i}`,
              supplier: row.supplier || "",
              parentSupplier: row.parentSupplier || "",
              zone: row.zone || "",
              country: row.country || "",
              category: row.category || "",
              kpiApplicability: row.kpiApplicability || "Applicable",
              invoiceOnTimeCount: row.invoiceOnTimeCount || "0",
              totalPoLines: row.totalPoLines || "0",
              year: row.year || "",
              month: row.month || "",
            }),
          );
          setRows(parsed);
          setUploadMessage(`${parsed.length} rows loaded.`);
        }
      })
      .catch(() => setUploadMessage("Backend not running."));
  };

  useEffect(() => { loadFromApi(); }, []);

  // Dynamic filter options
  const opts = useMemo(() => ({
    categories: Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort(),
    years: ["2025", "2026"],
    months: Array.from(new Set(rows.map((r) => r.month).filter(Boolean))).sort((a, b) => Number(a) - Number(b)),
    parentSuppliers: Array.from(new Set(rows.map((r) => r.parentSupplier).filter(Boolean))).sort(),
    suppliers: Array.from(new Set(rows.map((r) => r.supplier).filter(Boolean))).sort(),
    countries: Array.from(new Set(rows.map((r) => r.country).filter(Boolean))).sort(),
    zones: Array.from(new Set(rows.map((r) => r.zone).filter(Boolean))).sort(),
  }), [rows]);

  // Apply filters
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

  // contextRows excludes parent/supplier filters so percentile ranks match the
  // Normalized Scorecard backend (global/zone-contextual population).
  const contextRows = useMemo(() => {
    return rows.filter((row) => {
      if (selCategory.length > 0 && !selCategory.includes(row.category)) return false;
      if (selYear.length > 0 && !selYear.includes(row.year)) return false;
      if (selMonth.length > 0 && !selMonth.some((m) => normalizeMonth(m) === normalizeMonth(row.month))) return false;
      if (selCountry.length > 0 && !selCountry.includes(row.country)) return false;
      if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
      return true;
    });
  }, [rows, selCategory, selYear, selMonth, selCountry, selZone]);

  // Scoring
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;

  const scoredRows = useMemo(
    () => (configIsValid ? scoreIotRows(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );

  const zoneRollup = useMemo(
    () => (configIsValid ? calculateIotRollup(filteredRows, config, "zone") : []),
    [filteredRows, config, configIsValid],
  );
  const parentRollup = useMemo(
    () => (configIsValid ? calculateIotRollup(contextRows, config, "parentSupplier") : []),
    [contextRows, config, configIsValid],
  );
  const displayedParentRollup = useMemo(
    () => selParentSupplier.length > 0
      ? parentRollup.filter((r) => selParentSupplier.includes(r.label))
      : parentRollup,
    [parentRollup, selParentSupplier],
  );
  const categoryRollup = useMemo(
    () => (configIsValid ? calculateIotRollup(filteredRows, config, "category") : []),
    [filteredRows, config, configIsValid],
  );

  const updateNumericConfig = (field: "maxScore" | "criticalFloor" | "target", value: string, scale = 1) => {
    setConfig((c) => ({ ...c, [field]: value === "" ? Number.NaN : Number(value) / scale }));
  };

  const exportResults = () => {
    const csv = toCsv([
      ["IOT KPI Config"], ["Max Score", config.maxScore], ["Floor %", percent(config.criticalFloor, 2)], ["Target %", percent(config.target, 2)], ["Rows", filteredRows.length], [],
      ["Supplier Level"],
      ["Supplier", "Parent", "Zone", "Country", "Category", "IOT %", "Rank", "Percentile", "Attainment", "Max", "Earned", "Score %", "Status"],
      ...scoredRows.map((r) => [r.supplier, r.parentSupplier, r.zone, r.country, r.category, percent(r.iotPercent, 2), formatRank(r.rank), percent(r.percentile, 2), numeric(r.attainment, 4), numeric(config.maxScore, 2), numeric(r.earnedScore, 2), percent(r.scorePercent, 2), r.status]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "iot-kpi-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Invoice KPI</p>
          <h1>IOT Percentile Scoring</h1>
          <p className="kpi-value-note">
            Value = Invoice On-Time Count / Total PO Lines &times; 100
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
        <MultiSelectDropdown label="Month" options={opts.months} selected={selMonth} onChange={setSelMonth} />
        <MultiSelectDropdown label="Parent Supplier" options={opts.parentSuppliers} selected={selParentSupplier} onChange={setSelParentSupplier} searchable />
        <MultiSelectDropdown label="Supplier" options={opts.suppliers} selected={selSupplier} onChange={setSelSupplier} searchable />
        <MultiSelectDropdown label="Zone" options={opts.zones} selected={selZone} onChange={setSelZone} />
        <MultiSelectDropdown label="Country" options={opts.countries} selected={selCountry} onChange={setSelCountry} />
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
        <ApplyScorecardButton kpiId="IOT" floor={config.criticalFloor} target={config.target} maxScore={config.maxScore} apiBase={API_BASE} />
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
        <summary>How IOT Earned Score Is Calculated</summary>
        <div className="formula-ribbon">
          <div><span>1. IOT %</span><strong>Invoice On-Time Count / Total PO Lines</strong></div>
          <div><span>2. Attainment</span><strong>(IOT% &minus; Floor) / (Target &minus; Floor), clamped 0&ndash;1</strong></div>
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
                      <th>Supplier</th><th>Parent</th><th>Zone</th><th>Country</th><th>Category</th>
                      <th>Inv. On-Time</th><th>Tot. PO Lines</th>
                      <th>IOT %</th><th>Rank</th><th>Percentile</th><th>Attainment</th>
                      <th>Max</th><th>Earned</th><th>Score %</th><th>Status</th><th>Explanation</th>
                    </tr></thead>
                    <tbody>
                      {scoredRows.slice(0, 200).map((row) => (
                        <tr key={row.id} className={row.status === "Below critical floor" ? "invalid-row" : row.status === "Not Applicable" ? "not-applicable-row" : ""}>
                          <td>{row.supplier}</td>
                          <td>{row.parentSupplier}</td>
                          <td>{row.zone}</td>
                          <td>{row.country}</td>
                          <td>{row.category}</td>
                          <td>{row.invoiceOnTimeCount}</td>
                          <td>{row.totalPoLines}</td>
                          <td>{percent(row.iotPercent, 2)}</td>
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

function RollupTable({ rows, label, maxScore }: { rows: IotRollupRow[]; label: string; maxScore: number }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>{label}</th>
          <th>Inv. On-Time</th><th>Tot. PO Lines</th>
          <th>IOT %</th><th>Rank</th><th>Percentile</th>
          <th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th>
          <th>Status</th><th>Rows</th><th>Explanation</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.status === "Below critical floor" ? "invalid-row" : ""}>
              <td>{row.label}</td>
              <td>{rawInt(row.invoiceOnTimeCount)}</td>
              <td>{rawInt(row.totalPoLines)}</td>
              <td>{percent(row.iotPercent, 2)}</td>
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

export default IotKpiPage;
