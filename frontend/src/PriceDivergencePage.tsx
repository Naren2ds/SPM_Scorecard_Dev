import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculatePercentileRanks,
  calculateEarnedScore,
  validateConfig,
} from "./scoring";
import { toCsv } from "./csv";
import type { KpiConfig } from "./types";

// ─── Price Divergence Types ─────────────────────────────────────────────────

interface PdInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  kpiApplicability: string;
  poValue: string;
  invoiceValue: string;
  divergencePct: string;
  year: string;
  month: string;
}

interface PdScoredRow extends PdInputRow {
  divergence: number | null;
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
  v === null || !Number.isFinite(v) ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(1);

// ─── Inverted attainment (lower divergence = better) ────────────────────────

function invertedAttainment(divergence: number, floor: number, target: number): number {
  if (divergence >= floor) return 0;
  if (divergence <= target) return 1;
  return (floor - divergence) / (floor - target);
}

// ─── Multi-select dropdown ──────────────────────────────────────────────────

function MultiSelectDropdown({
  label, options, selected, onChange,
}: {
  label: string; options: string[]; selected: string[]; onChange: (v: string[]) => void;
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

  const displayLabel = selected.length === 0 ? "All" : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  return (
    <div className="ms-dropdown" ref={ref}>
      <span className="ms-label">{label}</span>
      <button type="button" className="ms-trigger" onClick={() => setOpen(!open)}>
        {displayLabel} <span className="ms-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="ms-panel">
          <label className="ms-item">
            <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
            All
          </label>
          {options.map((opt) => (
            <label key={opt} className="ms-item">
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggleValue(opt)} />
              {opt}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Price Divergence Scoring ───────────────────────────────────────────────

interface PdRollupRow {
  id: string;
  label: string;
  divergence: number | null;
  rank: number | null;
  percentile: number | null;
  attainment: number | null;
  earnedScore: number | null;
  scorePercent: number | null;
  status: string;
  explanation: string;
  contributingRows: number;
}

function scorePdRows(rows: PdInputRow[], config: KpiConfig): PdScoredRow[] {
  const assessed = rows.map((row) => {
    const isApplicable = row.kpiApplicability !== "Not Applicable";
    const divergence = isApplicable ? parseFloat(row.divergencePct) : null;
    const validDivergence = divergence !== null && Number.isFinite(divergence) ? divergence : null;
    return { ...row, divergence: isApplicable ? validDivergence : null, isApplicable };
  });

  // Rank: lower divergence = better, so negate for ranking (higher negated = lower divergence)
  const validRows = assessed
    .filter((r) => r.isApplicable && r.divergence !== null)
    .map((r) => ({ id: r.id, dot: -(r.divergence as number) }));

  const ranks = calculatePercentileRanks(validRows, config.target);

  return assessed.map((row) => {
    if (!row.isApplicable) {
      return { ...row, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Not Applicable", explanation: "Not applicable: excluded from ranking and scoring." };
    }
    if (row.divergence === null) {
      return { ...row, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Missing Data", explanation: "Missing data: no valid divergence value available." };
    }

    const rankInfo = ranks.get(row.id);
    const percentile = rankInfo?.percentile ?? null;
    const attainment = invertedAttainment(row.divergence, config.criticalFloor, config.target);
    const earnedScore = percentile !== null
      ? calculateEarnedScore(config.maxScore, percentile, attainment, config.formulaMode)
      : null;

    let status = "Valid score";
    if (row.divergence >= config.criticalFloor) status = "Below critical floor";

    const explanation = status === "Below critical floor"
      ? `Above critical floor: Divergence ${(row.divergence * 100).toFixed(2)}% ≥ floor ${(config.criticalFloor * 100).toFixed(2)}%. Attainment = 0, earned score = 0.`
      : config.formulaMode === "softStretch"
        ? `Valid score: Divergence ${(row.divergence * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned Score = ${config.maxScore} × ${attainment.toFixed(4)} × (70% + 30% × ${percentile !== null ? (percentile * 100).toFixed(2) : 0}%) = ${earnedScore?.toFixed(2) ?? 0}.`
        : `Valid score: Divergence ${(row.divergence * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned Score = ${config.maxScore} × ${percentile !== null ? (percentile * 100).toFixed(2) : 0}% × ${attainment.toFixed(4)} = ${earnedScore?.toFixed(2) ?? 0}.`;

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

function calculatePdRollup(
  rows: PdInputRow[],
  config: KpiConfig,
  groupBy: "zone" | "parentSupplier" | "category",
): PdRollupRow[] {
  const groups = new Map<string, { poValue: number; invoiceValue: number; count: number }>();
  rows.forEach((row) => {
    if (row.kpiApplicability === "Not Applicable") return;
    const key = row[groupBy]?.trim() || "Unassigned";
    const existing = groups.get(key) || { poValue: 0, invoiceValue: 0, count: 0 };
    existing.poValue += Number(row.poValue) || 0;
    existing.invoiceValue += Number(row.invoiceValue) || 0;
    existing.count += 1;
    groups.set(key, existing);
  });

  const seeds = Array.from(groups.entries()).map(([label, g], i) => {
    const divergence = g.poValue > 0 ? Math.abs(g.invoiceValue - g.poValue) / g.poValue : null;
    return {
      id: `rollup-${groupBy}-${i}`,
      label,
      divergence,
      contributingRows: g.count,
    };
  });

  // Rank: lower divergence = better, negate for ranking
  const validSeeds = seeds.filter((s) => s.divergence !== null);
  const ranks = calculatePercentileRanks(
    validSeeds.map((s) => ({ id: s.id, dot: -(s.divergence as number) })),
    config.target,
  );

  return seeds.map((seed) => {
    if (seed.divergence === null) {
      return { ...seed, rank: null, percentile: null, attainment: null, earnedScore: null, scorePercent: null, status: "Missing Data", explanation: "No valid data for this group." };
    }
    const rankInfo = ranks.get(seed.id);
    const percentile = rankInfo?.percentile ?? null;
    const attainment = invertedAttainment(seed.divergence, config.criticalFloor, config.target);
    const earnedScore = percentile !== null
      ? calculateEarnedScore(config.maxScore, percentile, attainment, config.formulaMode)
      : null;
    let status = "Valid score";
    if (seed.divergence >= config.criticalFloor) status = "Below critical floor";

    const explanation = status === "Below critical floor"
      ? `Above critical floor: Divergence ${(seed.divergence * 100).toFixed(2)}% ≥ floor ${(config.criticalFloor * 100).toFixed(2)}%. Earned score = 0.`
      : `Valid score: Divergence ${(seed.divergence * 100).toFixed(2)}%. Attainment = ${attainment.toFixed(4)}. Earned = ${earnedScore?.toFixed(2) ?? 0}. Rollup of ${seed.contributingRows} rows.`;

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

function PriceDivergencePage() {
  const [rows, setRows] = useState<PdInputRow[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [config, setConfig] = useState<KpiConfig>({
    maxScore: 10,
    criticalFloor: 0.15,
    target: 0.05,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });

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

  const loadFromApi = () => {
    fetch(`${API_BASE}/api/price-divergence`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data && json.data.length > 0) {
          const parsed: PdInputRow[] = json.data.map(
            (row: Record<string, string>, i: number) => ({
              id: row.id || `pd-${i}`,
              supplier: row.supplier || "",
              parentSupplier: row.parentSupplier || "",
              zone: row.zone || "",
              country: row.country || "",
              category: row.category || "",
              kpiApplicability: row.kpiApplicability || "Applicable",
              poValue: row.poValue || "0",
              invoiceValue: row.invoiceValue || "0",
              divergencePct: row.divergencePct || "0",
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

  const handleRefresh = () => {
    setRefreshing(true);
    setUploadMessage("Refreshing Price Divergence from Databricks...");
    fetch(`${API_BASE}/api/price-divergence/refresh`, { method: "POST" })
      .then(() => {
        const poll = setInterval(() => {
          fetch(`${API_BASE}/api/status`).then((r) => r.json()).then((j) => {
            if (j.status !== "refreshing") { clearInterval(poll); setRefreshing(false); loadFromApi(); }
          });
        }, 2000);
      })
      .catch(() => { setRefreshing(false); setUploadMessage("Refresh failed."); });
  };

  // Dynamic filter options
  const opts = useMemo(() => ({
    categories: Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort(),
    years: Array.from(new Set(rows.map((r) => r.year).filter(Boolean))).sort(),
    months: Array.from(new Set(rows.map((r) => r.month).filter(Boolean))).sort(),
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
      if (selMonth.length > 0 && !selMonth.includes(row.month)) return false;
      if (selParentSupplier.length > 0 && !selParentSupplier.includes(row.parentSupplier)) return false;
      if (selSupplier.length > 0 && !selSupplier.includes(row.supplier)) return false;
      if (selCountry.length > 0 && !selCountry.includes(row.country)) return false;
      if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
      return true;
    });
  }, [rows, selCategory, selYear, selMonth, selParentSupplier, selSupplier, selCountry, selZone]);

  // Scoring
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;

  const scoredRows = useMemo(
    () => (configIsValid ? scorePdRows(filteredRows, config) : []),
    [filteredRows, config, configIsValid],
  );

  const zoneRollup = useMemo(
    () => (configIsValid ? calculatePdRollup(filteredRows, config, "zone") : []),
    [filteredRows, config, configIsValid],
  );
  const parentRollup = useMemo(
    () => (configIsValid ? calculatePdRollup(filteredRows, config, "parentSupplier") : []),
    [filteredRows, config, configIsValid],
  );
  const categoryRollup = useMemo(
    () => (configIsValid ? calculatePdRollup(filteredRows, config, "category") : []),
    [filteredRows, config, configIsValid],
  );

  const updateNumericConfig = (field: "maxScore" | "criticalFloor" | "target", value: string, scale = 1) => {
    setConfig((c) => ({ ...c, [field]: value === "" ? Number.NaN : Number(value) / scale }));
  };

  const exportResults = () => {
    const csv = toCsv([
      ["Price Divergence KPI Config"], ["Max Score", config.maxScore], ["Floor %", percent(config.criticalFloor, 2)], ["Target %", percent(config.target, 2)], ["Rows", filteredRows.length], [],
      ["Supplier Level"],
      ["Supplier", "Parent", "Zone", "Country", "Category", "Year", "Month", "PO Value", "Invoice Value", "Divergence %", "Rank", "Percentile", "Attainment", "Max", "Earned", "Score %", "Status"],
      ...scoredRows.map((r) => [r.supplier, r.parentSupplier, r.zone, r.country, r.category, r.year, r.month, r.poValue, r.invoiceValue, percent(r.divergence, 2), formatRank(r.rank), percent(r.percentile, 2), numeric(r.attainment, 4), numeric(config.maxScore, 2), numeric(r.earnedScore, 2), percent(r.scorePercent, 2), r.status]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "price-divergence-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Procurement KPI</p>
          <h1>Price Divergence</h1>
          <p className="kpi-value-note">
            Price Divergence % = ABS(SUM Invoice Value &minus; SUM PO Value) / SUM PO Value. Lower = better.
          </p>
          {uploadMessage && <p className="supporting">{uploadMessage}</p>}
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh Data"}
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>Upload CSV</button>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv" onChange={() => {}} />
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
        <MultiSelectDropdown label="Parent Supplier" options={opts.parentSuppliers} selected={selParentSupplier} onChange={setSelParentSupplier} />
        <MultiSelectDropdown label="Supplier" options={opts.suppliers} selected={selSupplier} onChange={setSelSupplier} />
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
      </section>

      {/* Data Summary */}
      <section className="input-panel">
        <div className="panel-heading">
          <h2>Data Summary</h2>
          <p className="supporting">
            {rows.length > 0 ? `${rows.length} total rows. Showing ${filteredRows.length} after filters.` : "No data. Click Refresh Data."}
          </p>
        </div>
      </section>

      {/* Formula */}
      <details className="formula-panel collapsible-section" open>
        <summary>How Price Divergence Earned Score Is Calculated</summary>
        <div className="formula-ribbon">
          <div><span>1. Divergence %</span><strong>ABS(SUM Invoice Value &minus; SUM PO Value) / SUM PO Value</strong></div>
          <div><span>2. Attainment (inverted)</span><strong>If divergence &ge; floor: 0. If divergence &le; target: 1. Else: (floor &minus; divergence) / (floor &minus; target)</strong></div>
          <div><span>3. Percentile</span><strong>(N &minus; Rank) / (N &minus; 1), Rank 1 = lowest divergence</strong></div>
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
                      <th>Year</th><th>Month</th><th>PO Value</th><th>Invoice Value</th>
                      <th>Divergence %</th><th>Rank</th><th>Percentile</th><th>Attainment</th>
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
                          <td>{row.year}</td>
                          <td>{row.month}</td>
                          <td>{row.poValue}</td>
                          <td>{row.invoiceValue}</td>
                          <td>{percent(row.divergence, 2)}</td>
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
              <div className="rollup-scroll"><RollupTable rows={zoneRollup} label="Zone" config={config} /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">3</span><h3>Parent Supplier Rollup</h3></summary>
              <div className="rollup-scroll"><RollupTable rows={parentRollup} label="Parent Supplier" config={config} /></div>
            </details>
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary"><span className="level-badge">4</span><h3>Category Rollup</h3></summary>
              <div className="rollup-scroll"><RollupTable rows={categoryRollup} label="Category" config={config} /></div>
            </details>
          </div>
        )}
      </section>
    </>
  );
}

function RollupTable({ rows, label, config }: { rows: PdRollupRow[]; label: string; config: KpiConfig }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead><tr>
          <th>{label}</th><th>Divergence %</th><th>Rank</th><th>Percentile</th>
          <th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th>
          <th>Status</th><th>Rows</th><th>Explanation</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.status === "Below critical floor" ? "invalid-row" : ""}>
              <td>{row.label}</td>
              <td>{percent(row.divergence, 2)}</td>
              <td>{formatRank(row.rank)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainment, 4)}</td>
              <td>{numeric(config.maxScore, 2)}</td>
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

export default PriceDivergencePage;
