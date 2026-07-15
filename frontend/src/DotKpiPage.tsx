import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateCategoryRollup,
  calculateParentRollup,
  calculateZoneRollup,
  scoreSupplierRows,
  validateConfig,
  validateRows,
} from "./scoring";
import { parseSupplierRowsFromCsv, toCsv } from "./csv";
import type {
  KpiConfig,
  RollupRow,
  ScoredKpiRow,
  SupplierKpiInputRow,
} from "./types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(digits)}%`;

const numeric = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);

const formatRank = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "-"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(1);

const displayText = (value: string, fallback: string) => value.trim() || fallback;

const normalizeMonth = (m: string) => m.replace(/^0+/, "") || m;

// ─── Multi-select filter component ─────────────────────────────────────────

function MultiSelect({
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
  const handleToggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const allSelected = selected.length === 0;

  return (
    <div className="multi-select">
      <span className="multi-select-label">{label}</span>
      <div className="multi-select-options">
        <label className="multi-select-option">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => onChange([])}
          />
          All
        </label>
        {options.map((opt) => (
          <label key={opt} className="multi-select-option">
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              onChange={() => handleToggle(opt)}
            />
            {opt}
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

type TabMode = "filters" | "config";

function DotKpiPage() {
  const [rows, setRows] = useState<SupplierKpiInputRow[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [activeTab, setActiveTab] = useState<TabMode>("filters");
  const [config, setConfig] = useState<KpiConfig>({
    maxScore: 15,
    criticalFloor: 0.7,
    target: 0.85,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });

  // Multi-select filter states (empty array = All)
  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>([]);
  const [selMonth, setSelMonth] = useState<string[]>([]);
  const [selParentSupplier, setSelParentSupplier] = useState<string[]>([]);
  const [selSupplier, setSelSupplier] = useState<string[]>([]);
  const [selCountry, setSelCountry] = useState<string[]>([]);
  const [selZone, setSelZone] = useState<string[]>([]);

  const [refreshing, setRefreshing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const API_BASE = "http://127.0.0.1:8000";

  // Load cached data from API on mount (instant)
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
          setUploadMessage(`${parsed.length} rows loaded (${json.status}).`);
        }
      })
      .catch(() => {
        setUploadMessage("Backend not running. Upload CSV manually or start backend.");
      });
  };

  useEffect(() => {
    loadFromApi();
  }, []);

  // Refresh: trigger Databricks fetch, then reload data
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
      .catch(() => {
        setRefreshing(false);
        setUploadMessage("Refresh failed. Check backend.");
      });
  };

  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsedRows = parseSupplierRowsFromCsv(text);
    if (parsedRows.length === 0) {
      setUploadMessage("No supplier DOT rows were found in the CSV.");
      return;
    }
    setRows(parsedRows);
    setUploadMessage(`${parsedRows.length} rows loaded from ${file.name}.`);
    event.target.value = "";
  };

  // ─── Dynamic filter options from data ───────────────────────────────────
  const availableCategories = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort(),
    [rows],
  );
  const availableYears = useMemo(
    () => Array.from(new Set(rows.map((r) => r.year).filter(Boolean))).sort(),
    [rows],
  );
  const availableMonths = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.month).filter(Boolean))).sort(
        (a, b) => Number(a) - Number(b),
      ),
    [rows],
  );
  const availableParentSuppliers = useMemo(
    () => Array.from(new Set(rows.map((r) => r.parentSupplier).filter(Boolean))).sort(),
    [rows],
  );
  const availableSuppliers = useMemo(
    () => Array.from(new Set(rows.map((r) => r.supplier).filter(Boolean))).sort(),
    [rows],
  );
  const availableCountries = useMemo(
    () => Array.from(new Set(rows.map((r) => r.country).filter(Boolean))).sort(),
    [rows],
  );
  const availableZones = useMemo(
    () => Array.from(new Set(rows.map((r) => r.zone).filter(Boolean))).sort(),
    [rows],
  );

  // ─── Apply filters ──────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (selCategory.length > 0 && !selCategory.includes(row.category)) return false;
      if (selYear.length > 0 && !selYear.includes(row.year)) return false;
      if (
        selMonth.length > 0 &&
        !selMonth.some((m) => normalizeMonth(m) === normalizeMonth(row.month))
      )
        return false;
      if (selParentSupplier.length > 0 && !selParentSupplier.includes(row.parentSupplier))
        return false;
      if (selSupplier.length > 0 && !selSupplier.includes(row.supplier)) return false;
      if (selCountry.length > 0 && !selCountry.includes(row.country)) return false;
      if (selZone.length > 0 && !selZone.includes(row.zone)) return false;
      return true;
    });
  }, [rows, selCategory, selYear, selMonth, selParentSupplier, selSupplier, selCountry, selZone]);

  // ─── Scoring ────────────────────────────────────────────────────────────
  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;

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
  const updateNumericConfig = (
    field: "maxScore" | "criticalFloor" | "target",
    value: string,
    scale = 1,
  ) => {
    setConfig((c) => ({ ...c, [field]: value === "" ? Number.NaN : Number(value) / scale }));
  };

  const exportResults = () => {
    const csv = toCsv([
      ["DOT Config Values Used"],
      ["Max Score", config.maxScore],
      ["Critical Floor %", percent(config.criticalFloor, 2)],
      ["Target %", percent(config.target, 2)],
      ["Formula Mode", config.formulaMode === "softStretch" ? "Softer Percentile Stretch" : "Strict Percentile x Attainment"],
      ["Filtered Rows", filteredRows.length],
      [],
      ["Supplier Level Results"],
      ["Supplier", "Parent Supplier", "Zone", "Country", "Category", "DOT %", "Rank", "Percentile", "Attainment", "Max Score", "Earned Score", "Score %", "Status", "Explanation"],
      ...supplierScores.map((row) => [
        displayText(row.supplier, `Row ${row.rowNumber}`),
        displayText(row.parentSupplier, ""),
        displayText(row.zone, ""),
        displayText(row.country, ""),
        displayText(row.category, ""),
        percent(row.normalizedDot, 2),
        formatRank(row.rankDescending),
        percent(row.percentile, 2),
        numeric(row.attainmentFactor, 4),
        numeric(row.maxScore, 2),
        numeric(row.earnedScore, 2),
        percent(row.scorePercent, 2),
        row.scoreStatus,
        row.explanation,
      ]),
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
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Delivery KPI</p>
          <h1>DOT Percentile Scoring</h1>
          <p className="kpi-value-note">
            Value = On-Time PO Lines / (Total Delivered PO Lines + 0.99 &times;
            X1&nbsp;Delayed&nbsp;&gt;30d + 0.10 &times; X2&nbsp;Early&nbsp;&gt;30d)
          </p>
          {uploadMessage && <p className="supporting">{uploadMessage}</p>}
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh Data"}
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Upload CSV
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvUpload}
          />
          <button
            type="button"
            onClick={exportResults}
            disabled={!configIsValid || filteredRows.length === 0}
          >
            Export Results
          </button>
        </div>
      </section>

      {/* ─── Tabs: Filters | Configuration ─────────────────────────────── */}
      <section className="config-tabs">
        <div className="config-tab-buttons">
          <button
            type="button"
            className={activeTab === "filters" ? "active" : ""}
            onClick={() => setActiveTab("filters")}
          >
            Filters
          </button>
          <button
            type="button"
            className={activeTab === "config" ? "active" : ""}
            onClick={() => setActiveTab("config")}
          >
            Configuration
          </button>
        </div>

        {activeTab === "filters" && (
          <div className="config-bar filters-bar">
            <MultiSelect label="Category" options={availableCategories} selected={selCategory} onChange={setSelCategory} />
            <MultiSelect label="Year" options={availableYears} selected={selYear} onChange={setSelYear} />
            <MultiSelect label="Month" options={availableMonths} selected={selMonth} onChange={setSelMonth} />
            <MultiSelect label="Parent Supplier" options={availableParentSuppliers} selected={selParentSupplier} onChange={setSelParentSupplier} />
            <MultiSelect label="Supplier" options={availableSuppliers} selected={selSupplier} onChange={setSelSupplier} />
            <MultiSelect label="Zone" options={availableZones} selected={selZone} onChange={setSelZone} />
            <MultiSelect label="Country" options={availableCountries} selected={selCountry} onChange={setSelCountry} />
            <div className="filter-summary">
              Showing <strong>{filteredRows.length}</strong> of {rows.length} rows
            </div>
          </div>
        )}

        {activeTab === "config" && (
          <div className="config-bar">
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
              <span>Critical Floor %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={
                  Number.isFinite(config.criticalFloor)
                    ? Number((config.criticalFloor * 100).toFixed(4))
                    : ""
                }
                onChange={(e) => updateNumericConfig("criticalFloor", e.target.value, 100)}
              />
            </label>
            <label>
              <span>Target %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={
                  Number.isFinite(config.target)
                    ? Number((config.target * 100).toFixed(4))
                    : ""
                }
                onChange={(e) => updateNumericConfig("target", e.target.value, 100)}
              />
            </label>
            <label>
              <span>Formula Mode</span>
              <select
                value={config.formulaMode}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    formulaMode: e.target.value as "softStretch" | "strict",
                  }))
                }
              >
                <option value="softStretch">Softer Percentile Stretch</option>
                <option value="strict">Strict Percentile &times; Attainment</option>
              </select>
            </label>
            {configErrors.length > 0 && (
              <div className="validation-box config-bar-errors">
                {configErrors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ─── Results (scrollable rollups) ──────────────────────────────── */}
      <section className="results-panel">
        {filteredRows.length === 0 ? (
          <div className="empty-state">No data matches the current filters.</div>
        ) : !configIsValid ? (
          <div className="empty-state">Fix the configuration to calculate scores.</div>
        ) : (
          <div className="calculation-stack">
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">1</span>
                <h3>Supplier Level Calculation</h3>
              </summary>
              <div className="rollup-scroll">
                <SupplierResults rows={supplierScores} />
              </div>
            </details>

            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">2</span>
                <h3>Zone Level Rollup</h3>
              </summary>
              <div className="rollup-scroll">
                <RollupResults rows={zoneRollup} label="Zone" />
              </div>
            </details>

            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">3</span>
                <h3>Parent Level Rollup</h3>
              </summary>
              <div className="rollup-scroll">
                <RollupResults rows={parentRollup} label="Parent Supplier" />
              </div>
            </details>

            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">4</span>
                <h3>Category Level Rollup</h3>
              </summary>
              <div className="rollup-scroll">
                <RollupResults rows={categoryRollup} label="Category" />
              </div>
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
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Parent Supplier</th>
            <th>Zone</th>
            <th>Country</th>
            <th>Category</th>
            <th>DOT %</th>
            <th>Rank</th>
            <th>Percentile</th>
            <th>Attainment</th>
            <th>Max Score</th>
            <th>Earned Score</th>
            <th>Score %</th>
            <th>Status</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{displayText(row.supplier, `Row ${row.rowNumber}`)}</td>
              <td>{displayText(row.parentSupplier, "")}</td>
              <td>{displayText(row.zone, "")}</td>
              <td>{displayText(row.country, "")}</td>
              <td>{displayText(row.category, "")}</td>
              <td>{percent(row.normalizedDot, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td>
                <span className={`status-pill ${statusClass(row.scoreStatus)}`}>
                  {row.scoreStatus}
                </span>
              </td>
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
        <thead>
          <tr>
            <th>{label}</th>
            <th>DOT %</th>
            <th>Rank</th>
            <th>Percentile</th>
            <th>Attainment</th>
            <th>Max Score</th>
            <th>Earned Score</th>
            <th>Score %</th>
            <th>Status</th>
            <th>Rows</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{row.label}</td>
              <td>{percent(row.normalizedDot, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td>
                <span className={`status-pill ${statusClass(row.scoreStatus)}`}>
                  {row.scoreStatus}
                </span>
              </td>
              <td>{row.contributingRows}</td>
              <td className="explanation-cell">{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Status helpers ─────────────────────────────────────────────────────────

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
