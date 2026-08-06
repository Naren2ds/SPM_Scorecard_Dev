import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { MultiSelectDropdown } from "../shared/MultiSelectDropdown";
import { FixedMaxScore, ScoringConfigHeading } from "../shared/ScoringConfig";
import {
  KPI_SPECS,
  buildResults,
  calculateQuartiles,
  normalizeSourceRows,
} from "../shared/consistentKpiModel";
import type {
  DisplayResult,
  FormulaMode,
  KpiSpec,
  ResultLevel,
  SmallKpiId,
  SourceRow,
  WorkspaceConfig,
} from "../shared/consistentKpiModel";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const PAGE_SIZE = 100;

interface ConsistentKpiPageProps {
  kpiId: SmallKpiId;
  sharedParent: string[];
  onParentChange: (values: string[]) => void;
}

interface SearchResult {
  label: string;
  parentSupplier?: string;
}

const LEVELS: Array<{ id: ResultLevel; label: string; note: string }> = [
  { id: "parent", label: "Parent Rollup", note: "Default" },
  { id: "supplier", label: "Supplier Detail", note: "On demand" },
  { id: "zone", label: "Zone Rollup", note: "On demand" },
  { id: "category", label: "Category Rollup", note: "On demand" },
];

function ConsistentKpiPage({ kpiId, sharedParent, onParentChange }: ConsistentKpiPageProps) {
  const spec = KPI_SPECS[kpiId];
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [years, setYears] = useState<string[]>(["2025", "2026"]);
  const [zones, setZones] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [level, setLevel] = useState<ResultLevel>("parent");
  const [page, setPage] = useState(1);
  const [savedConfig, setSavedConfig] = useState<WorkspaceConfig>(spec.defaultConfig);
  const [draftConfig, setDraftConfig] = useState<WorkspaceConfig>(spec.defaultConfig);
  const [previewConfig, setPreviewConfig] = useState<WorkspaceConfig | null>(null);
  const [parentQuery, setParentQuery] = useState("");
  const [supplierQuery, setSupplierQuery] = useState("");
  const [resultQuery, setResultQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const deferredParentQuery = useDeferredValue(parentQuery);
  const deferredSupplierQuery = useDeferredValue(supplierQuery);
  const deferredResultQuery = useDeferredValue(resultQuery);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      fetch(`${API_BASE}${spec.endpoint}`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`Data request failed (${response.status})`);
        return response.json();
      }),
      fetch(`${API_BASE}/api/scorecard/config`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`Config request failed (${response.status})`);
        return response.json();
      }),
    ])
      .then(([dataResponse, configResponse]) => {
        const normalized = normalizeSourceRows(dataResponse.data ?? []);
        setRows(normalized);
        const availableYears = unique(normalized.map((row) => row.year));
        setYears(["2025", "2026"].filter((year) => availableYears.includes(year)));
        const serverConfig = configResponse[kpiId];
        const effective = {
          ...spec.defaultConfig,
          maxScore: numberOr(serverConfig?.maxScore, spec.defaultConfig.maxScore),
          criticalFloor: numberOr(serverConfig?.floor, spec.defaultConfig.criticalFloor),
          target: numberOr(serverConfig?.target, spec.defaultConfig.target),
          formulaMode: "softStretch" as FormulaMode,
        };
        setSavedConfig(effective);
        setDraftConfig(effective);
      })
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kpiId, spec]);

  const options = useMemo(() => ({
    categories: unique(rows.map((row) => row.category)),
    years: unique(rows.map((row) => row.year), true),
    zones: unique(rows.map((row) => row.zone)),
    countries: unique(rows.map((row) => row.country)),
  }), [rows]);

  const contextRows = useMemo(() => rows.filter((row) => {
    if (categories.length && !categories.includes(row.category)) return false;
    if (years.length && !years.includes(row.year)) return false;
    if (zones.length && !zones.includes(row.zone)) return false;
    if (countries.length && !countries.includes(row.country)) return false;
    return true;
  }), [rows, categories, years, zones, countries]);

  const quartiles = useMemo(
    () => spec.autoQuartiles ? calculateQuartiles(contextRows, spec) : null,
    [contextRows, spec],
  );

  useEffect(() => {
    if (!spec.autoQuartiles || !quartiles) return;
    setSavedConfig((current) => ({ ...current, criticalFloor: quartiles.q1, target: quartiles.q3 }));
    setDraftConfig((current) => ({ ...current, criticalFloor: quartiles.q1, target: quartiles.q3 }));
    setPreviewConfig(null);
  }, [quartiles?.q1, quartiles?.q3, spec.autoQuartiles]);

  const previewIsActive = previewConfig !== null
    && JSON.stringify(previewConfig) === JSON.stringify(draftConfig);
  const displayedConfig = previewIsActive && previewConfig ? previewConfig : savedConfig;
  const calculationRows = useMemo(() => {
    if ((level === "zone" || level === "category") && sharedParent.length > 0) {
      return contextRows.filter((row) => sharedParent.includes(parentLabel(row)));
    }
    return contextRows;
  }, [contextRows, level, sharedParent]);

  const levelResults = useMemo(() => buildResults(calculationRows, spec, displayedConfig, level)
    .sort((left, right) => {
      const rankDifference = (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY);
      return rankDifference || left.label.localeCompare(right.label);
    }), [calculationRows, spec, displayedConfig, level]);

  const visibleResults = useMemo(() => {
    const query = deferredResultQuery.trim().toLowerCase();
    return levelResults.filter((result) => {
      if (level === "parent" && sharedParent.length && !sharedParent.includes(result.label)) return false;
      if (level === "supplier") {
        if (sharedParent.length && !sharedParent.includes(parentLabel(result))) return false;
        if (suppliers.length && !suppliers.includes(result.label)) return false;
      }
      return !query || result.label.toLowerCase().includes(query) || result.parentSupplier.toLowerCase().includes(query);
    });
  }, [levelResults, deferredResultQuery, level, sharedParent, suppliers]);

  const totalPages = Math.ceil(visibleResults.length / PAGE_SIZE);
  const pagedResults = visibleResults.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const validResults = visibleResults.filter((result) => result.metric !== null);
  const averageMetric = validResults.length
    ? validResults.reduce((total, result) => total + (result.metric ?? 0), 0) / validResults.length
    : null;
  const earnedResults = visibleResults.filter((result) => result.earned !== null);
  const averageEarned = earnedResults.length
    ? earnedResults.reduce((total, result) => total + (result.earned ?? 0), 0) / earnedResults.length
    : null;

  const parentMatches = useMemo(() => {
    const query = deferredParentQuery.trim().toLowerCase();
    if (query.length < 2) return [];
    return unique(contextRows.map(parentLabel))
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 30)
      .map((label) => ({ label }));
  }, [contextRows, deferredParentQuery]);

  const supplierMatches = useMemo(() => {
    const query = deferredSupplierQuery.trim().toLowerCase();
    if (query.length < 2) return [];
    const names = new Map<string, string>();
    contextRows.forEach((row) => {
      const parent = parentLabel(row);
      if (sharedParent.length && !sharedParent.includes(parent)) return;
      if (row.supplier.toLowerCase().includes(query)) names.set(row.supplier, parent);
    });
    return Array.from(names, ([label, parentSupplier]) => ({ label, parentSupplier }))
      .sort((left, right) => left.label.localeCompare(right.label))
      .slice(0, 30);
  }, [contextRows, deferredSupplierQuery, sharedParent]);

  const configErrors = validateConfig(draftConfig);
  const hasDraftChanges = JSON.stringify(draftConfig) !== JSON.stringify(savedConfig);

  const updateConfig = (field: "criticalFloor" | "target", value: string, percentField = false) => {
    setDraftConfig((current) => ({
      ...current,
      [field]: value === "" ? Number.NaN : Number(value) / (percentField ? 100 : 1),
    }));
    setMessage("");
  };

  const runPreview = () => {
    if (configErrors.length) return;
    setPreviewConfig({ ...draftConfig, maxScore: savedConfig.maxScore });
    setPage(1);
    setMessage("Temporary preview is active. Official scorecard settings are unchanged.");
  };

  const discardPreview = () => {
    setPreviewConfig(null);
    setDraftConfig(savedConfig);
    setPage(1);
    setMessage("Preview discarded. Showing official saved results.");
  };

  const applyPreview = async () => {
    if (!previewIsActive || !previewConfig || draftConfig.formulaMode !== "softStretch" || configErrors.length || spec.autoQuartiles) return;
    setApplying(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/scorecard/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kpiId,
          floor: draftConfig.criticalFloor,
          target: draftConfig.target,
        }),
      });
      if (!response.ok) throw new Error(`Apply failed (${response.status})`);
      const applied = { ...draftConfig, maxScore: savedConfig.maxScore, formulaMode: "softStretch" as FormulaMode };
      setSavedConfig(applied);
      setDraftConfig(applied);
      setPreviewConfig(null);
      setMessage(`${spec.title} settings applied to the official scorecard.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Apply failed.");
    } finally {
      setApplying(false);
    }
  };

  const exportResults = () => {
    const supplierResults = buildResults(contextRows, spec, displayedConfig, "supplier").filter((result) => {
      if (sharedParent.length && !sharedParent.includes(parentLabel(result))) return false;
      return !suppliers.length || suppliers.includes(result.label);
    });
    const headers = ["Supplier", "Parent", "Zone", "Country", "Category", "Year", ...spec.rawColumns.map((column) => column.label), spec.metricShortLabel, "Rank", "Percentile", "Attainment", "Earned", "Status"];
    const csvRows = supplierResults.map((result) => [
      result.supplier, result.parentSupplier, result.zone, result.country, result.category, result.year,
      ...spec.rawColumns.map((column) => result.rawValues[column.key] ?? ""),
      result.metric ?? "", result.rank ?? "", result.percentile ?? "", result.attainment ?? "", result.earned ?? "", result.scoreStatus,
    ]);
    downloadCsv(`${kpiId.toLowerCase()}-results.csv`, [headers, ...csvRows]);
  };

  const selectParent = (value: string) => {
    if (!sharedParent.includes(value)) onParentChange([...sharedParent, value]);
    setParentQuery("");
    setSuppliers([]);
    setPage(1);
  };

  const selectSupplier = (value: string) => {
    if (!suppliers.includes(value)) setSuppliers((current) => [...current, value]);
    setSupplierQuery("");
    setPage(1);
  };

  return (
    <>
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">{spec.eyebrow}</p>
          <h1>{spec.title}</h1>
          <p className="kpi-value-note">Parent Rollup loads first. Supplier, Zone, and Category levels are shown on demand using one consistent KPI flow.</p>
        </div>
        <div className="header-actions"><button type="button" onClick={exportResults} disabled={loading || !rows.length}>Export Supplier CSV</button></div>
      </section>

      <section className="config-bar">
        <MultiSelectDropdown label="Category" options={options.categories} selected={categories} onChange={(values) => { setCategories(values); setPage(1); }} />
        <MultiSelectDropdown label="Year" options={options.years} selected={years} onChange={(values) => { setYears(values); setPage(1); }} />
        <MultiSelectDropdown label="Zone" options={options.zones} selected={zones} onChange={(values) => { setZones(values); setPage(1); }} />
        <MultiSelectDropdown label="Country" options={options.countries} selected={countries} onChange={(values) => { setCountries(values); setPage(1); }} />
        <div className="filter-summary"><strong>{contextRows.length.toLocaleString()}</strong> cohort rows</div>
      </section>

      <section className="dot-entity-filters" aria-label={`${spec.title} display filters`}>
        <EntitySearch label="Find Parent Supplier" query={parentQuery} setQuery={setParentQuery} matches={parentMatches} selected={sharedParent} onSelect={selectParent} onRemove={(value) => { onParentChange(sharedParent.filter((item) => item !== value)); setSuppliers([]); setPage(1); }} />
        {level === "supplier" && <EntitySearch label="Find Supplier" query={supplierQuery} setQuery={setSupplierQuery} matches={supplierMatches} selected={suppliers} onSelect={selectSupplier} onRemove={(value) => { setSuppliers(suppliers.filter((item) => item !== value)); setPage(1); }} />}
        <p className="supporting">Parent and Supplier ranks stay global within the top-filter cohort. Zone and Category are recalculated only from the selected parent's rows.</p>
      </section>

      <section className="config-bar dot-scenario-config">
        <ScoringConfigHeading />
        <FixedMaxScore value={savedConfig.maxScore} />
        <label><span>{spec.autoQuartiles ? "Critical Floor (Q1)" : "Critical Floor %"}</span><input type="number" min="0" step="0.1" value={Number.isFinite(draftConfig.criticalFloor) ? Number((draftConfig.criticalFloor * (spec.unit === "percent" ? 100 : 1)).toFixed(4)) : ""} onChange={(event) => updateConfig("criticalFloor", event.target.value, spec.unit === "percent")} disabled={spec.autoQuartiles} /></label>
        <label><span>{spec.autoQuartiles ? "Target (Q3)" : "Target %"}</span><input type="number" min="0" step="0.1" value={Number.isFinite(draftConfig.target) ? Number((draftConfig.target * (spec.unit === "percent" ? 100 : 1)).toFixed(4)) : ""} onChange={(event) => updateConfig("target", event.target.value, spec.unit === "percent")} disabled={spec.autoQuartiles} /></label>
        <label><span>Formula Mode</span><input className="fixed-config-value" type="text" value="Soft Stretch (official)" readOnly aria-readonly="true" /></label>
        <div className="dot-scenario-actions"><button type="button" onClick={runPreview} disabled={applying || configErrors.length > 0}>Preview</button>{!spec.autoQuartiles && <button type="button" onClick={applyPreview} disabled={applying || !previewIsActive || !hasDraftChanges || draftConfig.formulaMode !== "softStretch"}>Apply to Scorecard</button>}{previewConfig && <button type="button" className="ghost-button" onClick={discardPreview} disabled={applying}>Discard</button>}</div>
        {configErrors.length > 0 && <div className="validation-box config-bar-errors">{configErrors.map((item) => <p key={item}>{item}</p>)}</div>}
      </section>

      <section className={`dot-scenario-banner ${previewIsActive ? "is-preview" : "is-saved"}`}>
        <strong>{previewIsActive ? "Temporary preview" : "Official saved results"}</strong>
        <span>{previewIsActive ? "Soft Stretch scenario is active. Nothing has been saved." : spec.autoQuartiles ? "Floor and Target automatically follow Q1 and Q3 of the top-filter cohort." : hasDraftChanges ? "Configuration was edited. Run Preview to recalculate; the table still shows saved results." : `Soft Stretch is the production ${spec.title} formula.`}</span>
        {message && <span>{message}</span>}
      </section>

      <section className="dot-summary-grid">
        <SummaryCard label="Source rows" value={rows.length.toLocaleString()} />
        <SummaryCard label="Global comparison cohort" value={contextRows.length.toLocaleString()} />
        <SummaryCard label={`Displayed ${level} rows`} value={visibleResults.length.toLocaleString()} />
        <SummaryCard label="Contributing rows" value={validResults.length.toLocaleString()} />
        <SummaryCard label={spec.metricLabel} value={formatMetric(averageMetric, spec)} />
        <SummaryCard label="Average earned" value={averageEarned === null ? "-" : averageEarned.toFixed(2)} />
      </section>

      <details className="formula-panel collapsible-section">
        <summary>How {spec.title} Earned Score Is Calculated</summary>
        <div className="formula-ribbon"><div><span>{spec.metricShortLabel}</span><strong>{spec.formula}</strong></div><div><span>Rollup</span><strong>{spec.rollupFormula}</strong></div><div><span>Official earned score</span><strong>Max x Attainment x (70% + 30% x Percentile)</strong></div></div>
        <p>Soft Stretch uses Max x Attainment x (70% + 30% x Percentile). Parent selection never changes the global Parent or Supplier rank.</p>
      </details>

      <section className="results-panel">
        <div className="dot-level-tabs" role="tablist" aria-label={`${spec.title} result level`}>{LEVELS.map((item) => <button type="button" role="tab" aria-selected={level === item.id} className={level === item.id ? "is-active" : ""} key={item.id} onClick={() => { setLevel(item.id); setPage(1); setResultQuery(""); }}><strong>{item.label}</strong><span>{item.note}</span></button>)}</div>
        <div className="dot-results-toolbar"><div><h2>{LEVELS.find((item) => item.id === level)?.label}</h2><p className="supporting">{visibleResults.length.toLocaleString()} matching results. Page {page} of {Math.max(totalPages, 1)}.</p></div><label><span>Search this level</span><input value={resultQuery} onChange={(event) => { setResultQuery(event.target.value); setPage(1); }} placeholder="Type a name" /></label></div>
        {error ? <div className="validation-box"><p>{error}</p></div> : loading ? <div className="empty-state">Loading {spec.title}...</div> : !pagedResults.length ? <div className="empty-state">No {spec.title} results match these filters.</div> : <ResultsTable rows={pagedResults} level={level} spec={spec} config={displayedConfig} />}
        <div className="dot-pagination"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1}>Previous</button><span>Page {page} / {Math.max(totalPages, 1)}</span><button type="button" onClick={() => setPage((current) => current + 1)} disabled={loading || page >= totalPages}>Next</button></div>
      </section>
    </>
  );
}

function ResultsTable({ rows, level, spec, config }: { rows: DisplayResult[]; level: ResultLevel; spec: KpiSpec; config: WorkspaceConfig }) {
  const supplierLevel = level === "supplier";
  return <div className="table-frame rollup-scroll"><table className="data-table results-table"><thead><tr><th>{supplierLevel ? "Supplier" : level === "parent" ? "Parent Supplier" : level === "zone" ? "Zone" : "Category"}</th>{supplierLevel && <><th>Parent</th><th>Zone</th><th>Country</th><th>Category</th><th>Year</th></>}{spec.rawColumns.map((column) => <th key={column.key}>{column.label}</th>)}<th>{spec.metricShortLabel}</th><th>Rank</th><th>Percentile</th><th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th><th>Status</th><th>Contributing Rows</th><th>Explanation</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className={rowClass(row.scoreStatus)}><td>{row.label}</td>{supplierLevel && <><td>{row.parentSupplier}</td><td>{row.zone}</td><td>{row.country || "-"}</td><td>{row.category || "-"}</td><td>{row.year || "-"}</td></>}{spec.rawColumns.map((column) => <td key={column.key}>{formatRaw(row.rawValues[column.key])}</td>)}<td>{formatMetric(row.metric, spec)}</td><td>{formatRank(row.rank)}</td><td>{formatPercent(row.percentile)}</td><td>{formatNumber(row.attainment, 4)}</td><td>{config.maxScore.toFixed(2)}</td><td>{formatNumber(row.earned)}</td><td>{formatPercent(row.earned === null ? null : row.earned / config.maxScore)}</td><td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td><td>{row.contributingRows}</td><td className="explanation-cell">{row.explanation}</td></tr>)}</tbody></table></div>;
}

function EntitySearch({ label, query, setQuery, matches, selected, onSelect, onRemove }: { label: string; query: string; setQuery: (value: string) => void; matches: SearchResult[]; selected: string[]; onSelect: (value: string) => void; onRemove: (value: string) => void }) {
  return <div className="dot-entity-search"><label><span>{label}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type at least 2 characters" /></label>{matches.length > 0 && <div className="dot-search-results">{matches.map((item) => <button type="button" key={`${item.parentSupplier ?? ""}-${item.label}`} onClick={() => onSelect(item.label)}>{item.label}{item.parentSupplier ? <small>{item.parentSupplier}</small> : null}</button>)}</div>}{selected.length > 0 && <div className="dot-selection-chips">{selected.map((item) => <button type="button" key={item} onClick={() => onRemove(item)} title={`Remove ${item}`}>{item} <span aria-hidden="true">x</span></button>)}</div>}</div>;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function unique(values: string[], numericSort = false): string[] {
  const output = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return output.sort(numericSort ? (left, right) => Number(left) - Number(right) : (left, right) => left.localeCompare(right));
}

function parentLabel(value: SourceRow | DisplayResult): string {
  return value.parentSupplier.trim() || "Unassigned parent";
}

function validateConfig(config: WorkspaceConfig): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(config.maxScore) || config.maxScore <= 0) errors.push("Max Score must be greater than 0.");
  if (!Number.isFinite(config.criticalFloor) || config.criticalFloor < 0) errors.push("Critical Floor must be zero or greater.");
  if (!Number.isFinite(config.target) || config.target < 0) errors.push("Target must be zero or greater.");
  if (config.criticalFloor >= config.target) errors.push("Critical Floor must be less than Target.");
  return errors;
}

function formatMetric(value: number | null, spec: KpiSpec): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return spec.unit === "percent" ? `${(value * 100).toFixed(2)}%` : value.toFixed(2);
}

function formatNumber(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(2)}%`;
}

function formatRank(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatRaw(value: number | string | undefined): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return value || "-";
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const content = rows.map((row) => row.map((value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const rowClass = (status: string) => status === "Missing Data" ? "invalid-row" : status === "Not Applicable" ? "not-applicable-row" : "";
const statusClass = (status: string) => status === "Missing Data" ? "status-invalid" : status === "Not Applicable" ? "status-na" : status === "Below critical floor" ? "status-floor" : "status-valid";

export default ConsistentKpiPage;



