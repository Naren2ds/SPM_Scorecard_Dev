import { useDeferredValue, useEffect, useState } from "react";
import { MultiSelectDropdown } from "../shared/MultiSelectDropdown";
import { FixedMaxScore, ScoringConfigHeading } from "../shared/ScoringConfig";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

type IotLevel = "parent" | "supplier" | "zone" | "category";
type FormulaMode = "softStretch" | "strict";

interface IotConfig {
  maxScore: number;
  criticalFloor: number;
  target: number;
  formulaMode: FormulaMode;
}

interface IotFilterOptions {
  categories: string[];
  years: string[];
  months: string[];
  countries: string[];
  zones: string[];
}

interface IotResult {
  id: string;
  level: IotLevel;
  label: string;
  supplier?: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category?: string;
  scorecardCategory: string;
  invoiceOnTimeCount: number;
  totalPoLines: number;
  normalizedIot: number | null;
  rankDescending: number | null;
  percentile: number | null;
  attainmentFactor: number | null;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: string;
  contributingRows: number;
  explanation: string;
}

interface IotResultsResponse {
  items: IotResult[];
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  level: IotLevel;
}

interface IotSummary {
  source_row_count: number;
  cohort_row_count: number;
  result_count: number;
  valid_result_count: number;
  average_iot_pct: number;
  average_earned_score: number;
}

interface SearchResult {
  label: string;
  parentSupplier?: string;
}

interface PreviewState {
  id: string;
  cohortSignature: string;
  configSignature: string;
}

interface IotKpiPageProps {
  sharedParent: string[];
  onParentChange: (values: string[]) => void;
}

const EMPTY_FILTERS: IotFilterOptions = {
  categories: [], years: [], months: [], countries: [], zones: [],
};

const DEFAULT_CONFIG: IotConfig = {
  maxScore: 10,
  criticalFloor: 0.7,
  target: 0.85,
  formulaMode: "softStretch",
};

const LEVELS: Array<{ id: IotLevel; label: string; note: string }> = [
  { id: "parent", label: "Parent Rollup", note: "Default" },
  { id: "supplier", label: "Supplier Detail", note: "On demand" },
  { id: "zone", label: "Zone Rollup", note: "On demand" },
  { id: "category", label: "Category Rollup", note: "On demand" },
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || body.message || `Request failed (${response.status})`);
  return body as T;
}

function appendList(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, values.join(","));
}

function contextParams(
  categories: string[], years: string[], months: string[], countries: string[], zones: string[],
) {
  const params = new URLSearchParams();
  appendList(params, "categories", categories);
  appendList(params, "years", years);
  appendList(params, "months", months);
  appendList(params, "countries", countries);
  appendList(params, "zones", zones);
  return params;
}

function validateConfig(config: IotConfig) {
  const errors: string[] = [];
  if (!Number.isFinite(config.maxScore) || config.maxScore <= 0) errors.push("Max Score must be greater than 0.");
  if (!Number.isFinite(config.criticalFloor) || config.criticalFloor < 0 || config.criticalFloor > 1) errors.push("Critical Floor must be between 0% and 100%.");
  if (!Number.isFinite(config.target) || config.target < 0 || config.target > 1) errors.push("Target must be between 0% and 100%.");
  if (config.criticalFloor >= config.target) errors.push("Critical Floor must be less than Target.");
  return errors;
}

const percent = (value: number | null, digits = 2) =>
  value == null || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(digits)}%`;
const numeric = (value: number | null, digits = 2) =>
  value == null || !Number.isFinite(value) ? "-" : value.toFixed(digits);
const rank = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

function IotKpiPageOptimized({ sharedParent, onParentChange }: IotKpiPageProps) {
  const [filterOptions, setFilterOptions] = useState<IotFilterOptions>(EMPTY_FILTERS);
  const [categories, setCategories] = useState<string[]>([]);
  const [years, setYears] = useState<string[]>(["2025", "2026"]);
  const [months, setMonths] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [level, setLevel] = useState<IotLevel>("parent");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<IotResultsResponse | null>(null);
  const [summary, setSummary] = useState<IotSummary | null>(null);
  const [savedConfig, setSavedConfig] = useState<IotConfig>(DEFAULT_CONFIG);
  const [draftConfig, setDraftConfig] = useState<IotConfig>(DEFAULT_CONFIG);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [parentQuery, setParentQuery] = useState("");
  const [supplierQuery, setSupplierQuery] = useState("");
  const [resultQuery, setResultQuery] = useState("");
  const [parentMatches, setParentMatches] = useState<SearchResult[]>([]);
  const [supplierMatches, setSupplierMatches] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const deferredParentQuery = useDeferredValue(parentQuery);
  const deferredSupplierQuery = useDeferredValue(supplierQuery);
  const deferredResultQuery = useDeferredValue(resultQuery);
  const cohortSignature = JSON.stringify([categories, years, months, countries, zones]);
  const draftSignature = JSON.stringify(draftConfig);
  const savedSignature = JSON.stringify(savedConfig);
  const configErrors = validateConfig(draftConfig);
  const previewIsActive = preview?.cohortSignature === cohortSignature && preview.configSignature === draftSignature;
  const activePreviewId = previewIsActive && preview ? preview.id : null;
  const hasDraftChanges = draftSignature !== savedSignature;

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchJson<{ config: IotConfig }>(`${API_BASE}/api/iot/config`, { signal: controller.signal }),
      fetchJson<IotFilterOptions>(`${API_BASE}/api/iot/filters`, { signal: controller.signal }),
    ])
      .then(([configResponse, options]) => {
        setSavedConfig(configResponse.config);
        setDraftConfig(configResponse.config);
        setFilterOptions(options);
        setYears(["2025", "2026"].filter((year) => options.years.includes(year)));
      })
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = contextParams(categories, years, months, countries, zones);
    params.set("level", level);
    params.set("page", String(page));
    params.set("page_size", "100");
    params.set("sort", "rankDescending");
    params.set("order", "asc");
    appendList(params, "parents", sharedParent);
    if (level === "supplier") appendList(params, "suppliers", suppliers);
    if (deferredResultQuery.trim()) params.set("search", deferredResultQuery.trim());
    if (activePreviewId) params.set("preview_id", activePreviewId);

    const summaryParams = contextParams(categories, years, months, countries, zones);
    summaryParams.set("level", level);
    appendList(summaryParams, "parents", sharedParent);
    if (level === "supplier") appendList(summaryParams, "suppliers", suppliers);
    if (deferredResultQuery.trim()) summaryParams.set("search", deferredResultQuery.trim());
    if (activePreviewId) summaryParams.set("preview_id", activePreviewId);

    setLoading(true);
    setError("");
    Promise.all([
      fetchJson<IotResultsResponse>(`${API_BASE}/api/iot/results?${params}`, { signal: controller.signal }),
      fetchJson<IotSummary>(`${API_BASE}/api/iot/summary?${summaryParams}`, { signal: controller.signal }),
    ])
      .then(([resultResponse, summaryResponse]) => {
        setResults(resultResponse);
        setSummary(summaryResponse);
      })
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [level, page, categories, years, months, countries, zones, sharedParent, suppliers, deferredResultQuery, activePreviewId]);

  useEffect(() => {
    if (deferredParentQuery.trim().length < 2) {
      setParentMatches([]);
      return;
    }
    const controller = new AbortController();
    const params = contextParams(categories, years, months, countries, zones);
    params.set("level", "parent");
    params.set("q", deferredParentQuery.trim());
    params.set("limit", "30");
    if (activePreviewId) params.set("preview_id", activePreviewId);
    fetchJson<{ items: SearchResult[] }>(`${API_BASE}/api/iot/search?${params}`, { signal: controller.signal })
      .then((response) => setParentMatches(response.items))
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, [deferredParentQuery, cohortSignature, activePreviewId]);

  useEffect(() => {
    if (deferredSupplierQuery.trim().length < 2) {
      setSupplierMatches([]);
      return;
    }
    const controller = new AbortController();
    const params = contextParams(categories, years, months, countries, zones);
    params.set("level", "supplier");
    params.set("q", deferredSupplierQuery.trim());
    params.set("limit", "30");
    appendList(params, "parents", sharedParent);
    if (activePreviewId) params.set("preview_id", activePreviewId);
    fetchJson<{ items: SearchResult[] }>(`${API_BASE}/api/iot/search?${params}`, { signal: controller.signal })
      .then((response) => setSupplierMatches(response.items))
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, [deferredSupplierQuery, cohortSignature, sharedParent, activePreviewId]);

  const updateConfigNumber = (field: "criticalFloor" | "target", value: string, scale = 1) => {
    setDraftConfig((current) => ({ ...current, [field]: value === "" ? Number.NaN : Number(value) / scale }));
    setMessage("");
  };

  const runPreview = async () => {
    if (configErrors.length > 0) return;
    setScenarioBusy(true);
    setMessage("Building a temporary IOT preview for this cohort...");
    setError("");
    try {
      const response = await fetchJson<{ previewId: string }>(`${API_BASE}/api/iot/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draftConfig, maxScore: savedConfig.maxScore, filters: { categories, years, months, countries, zones } }),
      });
      setPreview({ id: response.previewId, cohortSignature, configSignature: draftSignature });
      setPage(1);
      setMessage("Preview is active. Official scorecard settings are unchanged.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Preview failed.");
      setMessage("");
    } finally {
      setScenarioBusy(false);
    }
  };

  const discardPreview = async () => {
    if (preview) await fetch(`${API_BASE}/api/iot/preview/${preview.id}`, { method: "DELETE" }).catch(() => undefined);
    setPreview(null);
    setDraftConfig(savedConfig);
    setPage(1);
    setMessage("Preview discarded. Showing official saved results.");
  };

  const applyPreview = async () => {
    if (!previewIsActive || draftConfig.formulaMode !== "softStretch" || configErrors.length > 0) return;
    setScenarioBusy(true);
    setMessage("Applying IOT Soft Stretch settings and rebuilding the official scorecard...");
    setError("");
    try {
      await fetchJson(`${API_BASE}/api/scorecard/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpiId: "IOT", floor: draftConfig.criticalFloor, target: draftConfig.target }),
      });
      const applied = { ...draftConfig, maxScore: savedConfig.maxScore, formulaMode: "softStretch" as const };
      setSavedConfig(applied);
      setDraftConfig(applied);
      setPreview(null);
      setPage(1);
      setMessage("IOT Soft Stretch settings applied to the official scorecard.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Apply failed.");
      setMessage("");
    } finally {
      setScenarioBusy(false);
    }
  };

  const exportResults = () => {
    const params = contextParams(categories, years, months, countries, zones);
    appendList(params, "parents", sharedParent);
    appendList(params, "suppliers", suppliers);
    if (activePreviewId) params.set("preview_id", activePreviewId);
    window.location.assign(`${API_BASE}/api/iot/export?${params}`);
  };

  const selectParent = (value: string) => {
    if (!sharedParent.includes(value)) onParentChange([...sharedParent, value]);
    setParentQuery("");
    setParentMatches([]);
    setSuppliers([]);
    setPage(1);
  };

  const selectSupplier = (value: string) => {
    if (!suppliers.includes(value)) setSuppliers((current) => [...current, value]);
    setSupplierQuery("");
    setSupplierMatches([]);
    setPage(1);
  };

  return (
    <>
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Invoice KPI</p>
          <h1>IOT Percentile Scoring</h1>
          <p className="kpi-value-note">IOT = Invoice On-Time Count / Total PO Lines. Parent Rollup loads first; other levels calculate on demand.</p>
        </div>
        <div className="header-actions"><button type="button" onClick={exportResults} disabled={loading || !results?.total_items}>Export Supplier CSV</button></div>
      </section>

      <section className="config-bar">
        <MultiSelectDropdown label="Category" options={filterOptions.categories} selected={categories} onChange={(values) => { setCategories(values); setPage(1); }} />
        <MultiSelectDropdown label="Year" options={filterOptions.years} selected={years} onChange={(values) => { setYears(values); setPage(1); }} />
        <MultiSelectDropdown label="Month" options={filterOptions.months} selected={months} onChange={(values) => { setMonths(values); setPage(1); }} />
        <MultiSelectDropdown label="Zone" options={filterOptions.zones} selected={zones} onChange={(values) => { setZones(values); setPage(1); }} />
        <MultiSelectDropdown label="Country" options={filterOptions.countries} selected={countries} onChange={(values) => { setCountries(values); setPage(1); }} />
        <div className="filter-summary"><strong>{summary?.cohort_row_count.toLocaleString() ?? "-"}</strong> cohort rows</div>
      </section>

      <section className="dot-entity-filters" aria-label="IOT display filters">
        <EntitySearch label="Find Parent Supplier" query={parentQuery} setQuery={setParentQuery} matches={parentMatches} selected={sharedParent} onSelect={selectParent} onRemove={(value) => { onParentChange(sharedParent.filter((item) => item !== value)); setSuppliers([]); setPage(1); }} />
        {level === "supplier" && <EntitySearch label="Find Supplier" query={supplierQuery} setQuery={setSupplierQuery} matches={supplierMatches} selected={suppliers} onSelect={selectSupplier} onRemove={(value) => { setSuppliers(suppliers.filter((item) => item !== value)); setPage(1); }} />}
        <p className="supporting">Parent and Supplier ranks stay within their scorecard-category cohort across the top filters. Zone and Category are recalculated from the selected parent's IOT rows.</p>
      </section>

      <section className="config-bar dot-scenario-config">
        <ScoringConfigHeading />
        <FixedMaxScore value={savedConfig.maxScore} />
        <label><span>Critical Floor %</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(draftConfig.criticalFloor) ? Number((draftConfig.criticalFloor * 100).toFixed(4)) : ""} onChange={(event) => updateConfigNumber("criticalFloor", event.target.value, 100)} /></label>
        <label><span>Target %</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(draftConfig.target) ? Number((draftConfig.target * 100).toFixed(4)) : ""} onChange={(event) => updateConfigNumber("target", event.target.value, 100)} /></label>
        <label><span>Formula Mode</span><input className="fixed-config-value" type="text" value="Soft Stretch (official)" readOnly aria-readonly="true" /></label>
        <div className="dot-scenario-actions"><button type="button" onClick={runPreview} disabled={scenarioBusy || configErrors.length > 0}>Preview</button><button type="button" onClick={applyPreview} disabled={scenarioBusy || !previewIsActive || !hasDraftChanges || draftConfig.formulaMode !== "softStretch"}>Apply to Scorecard</button>{preview && <button type="button" className="ghost-button" onClick={discardPreview} disabled={scenarioBusy}>Discard</button>}</div>
        {configErrors.length > 0 && <div className="validation-box config-bar-errors">{configErrors.map((item) => <p key={item}>{item}</p>)}</div>}
      </section>

      <section className={`dot-scenario-banner ${previewIsActive ? "is-preview" : "is-saved"}`}>
        <strong>{previewIsActive ? "Temporary preview" : "Official saved results"}</strong>
        <span>{previewIsActive ? "Soft Stretch scenario is active. Nothing has been saved." : hasDraftChanges ? "Configuration was edited. Run Preview to recalculate; the table still shows saved results." : "Soft Stretch is the production IOT formula."}</span>
        {message && <span>{message}</span>}
      </section>

      <section className="dot-summary-grid">
        <SummaryCard label="Source rows" value={summary?.source_row_count.toLocaleString() ?? "-"} />
        <SummaryCard label="Global comparison cohort" value={summary?.cohort_row_count.toLocaleString() ?? "-"} />
        <SummaryCard label={`Displayed ${level} rows`} value={summary?.result_count.toLocaleString() ?? "-"} />
        <SummaryCard label="Contributing rows" value={summary?.valid_result_count.toLocaleString() ?? "-"} />
        <SummaryCard label="Average IOT" value={summary ? `${summary.average_iot_pct.toFixed(2)}%` : "-"} />
        <SummaryCard label="Average earned" value={summary ? summary.average_earned_score.toFixed(2) : "-"} />
      </section>

      <details className="formula-panel collapsible-section">
        <summary>How IOT Earned Score Is Calculated</summary>
        <div className="formula-ribbon"><div><span>IOT</span><strong>Invoice On-Time Count / Total PO Lines</strong></div><div><span>Attainment</span><strong>(IOT - Floor) / (Target - Floor), limited to 0-1</strong></div><div><span>Official earned score</span><strong>Max x Attainment x (70% + 30% x Percentile)</strong></div></div>
        <p>Rollups use summed invoice counts, not an average of supplier percentages. Soft Stretch uses Max x Attainment x (70% + 30% x Percentile).</p>
      </details>

      <section className="results-panel">
        <div className="dot-level-tabs" role="tablist" aria-label="IOT result level">{LEVELS.map((item) => <button type="button" role="tab" aria-selected={level === item.id} className={level === item.id ? "is-active" : ""} key={item.id} onClick={() => { setLevel(item.id); setPage(1); setResultQuery(""); }}><strong>{item.label}</strong><span>{item.note}</span></button>)}</div>
        <div className="dot-results-toolbar"><div><h2>{LEVELS.find((item) => item.id === level)?.label}</h2><p className="supporting">{results ? `${results.total_items.toLocaleString()} matching results. Page ${results.page} of ${Math.max(results.total_pages, 1)}.` : "Loading results..."}</p></div><label><span>Search this level</span><input value={resultQuery} onChange={(event) => { setResultQuery(event.target.value); setPage(1); }} placeholder="Type a name" /></label></div>
        {error ? <div className="validation-box"><p>{error}</p></div> : loading ? <div className="empty-state">Loading the selected IOT result level...</div> : !results?.items.length ? <div className="empty-state">No IOT results match these filters.</div> : <IotResultsTable rows={results.items} level={level} />}
        <div className="dot-pagination"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1}>Previous</button><span>Page {results?.page ?? page} / {Math.max(results?.total_pages ?? 1, 1)}</span><button type="button" onClick={() => setPage((current) => current + 1)} disabled={loading || !results || page >= results.total_pages}>Next</button></div>
      </section>
    </>
  );
}

function EntitySearch({ label, query, setQuery, matches, selected, onSelect, onRemove }: { label: string; query: string; setQuery: (value: string) => void; matches: SearchResult[]; selected: string[]; onSelect: (value: string) => void; onRemove: (value: string) => void }) {
  return <div className="dot-entity-search"><label><span>{label}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type at least 2 characters" /></label>{matches.length > 0 && <div className="dot-search-results">{matches.map((item) => <button type="button" key={`${item.parentSupplier ?? ""}-${item.label}`} onClick={() => onSelect(item.label)}>{item.label}{item.parentSupplier ? <small>{item.parentSupplier}</small> : null}</button>)}</div>}{selected.length > 0 && <div className="dot-selection-chips">{selected.map((item) => <button type="button" key={item} onClick={() => onRemove(item)} title={`Remove ${item}`}>{item} <span aria-hidden="true">x</span></button>)}</div>}</div>;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function IotResultsTable({ rows, level }: { rows: IotResult[]; level: IotLevel }) {
  const supplierLevel = level === "supplier";
  return <div className="table-frame rollup-scroll"><table className="data-table results-table"><thead><tr><th>{supplierLevel ? "Supplier" : level === "parent" ? "Parent Supplier" : level === "zone" ? "Zone" : "Category"}</th><th>Scorecard Category</th>{supplierLevel && <><th>Parent</th><th>Zone</th><th>Country</th><th>Category</th></>}<th>Inv. On-Time</th><th>Total PO Lines</th><th>IOT %</th><th>Rank</th><th>Percentile</th><th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th><th>Status</th><th>Contributing Rows</th><th>Explanation</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className={rowClass(row.scoreStatus)}><td>{row.label}</td><td>{row.scorecardCategory}</td>{supplierLevel && <><td>{row.parentSupplier}</td><td>{row.zone}</td><td>{row.country}</td><td>{row.category}</td></>}<td>{numeric(row.invoiceOnTimeCount, 0)}</td><td>{numeric(row.totalPoLines, 0)}</td><td>{percent(row.normalizedIot)}</td><td>{rank(row.rankDescending)}</td><td>{percent(row.percentile)}</td><td>{numeric(row.attainmentFactor, 4)}</td><td>{numeric(row.maxScore)}</td><td>{numeric(row.earnedScore)}</td><td>{percent(row.scorePercent)}</td><td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td><td>{row.contributingRows}</td><td className="explanation-cell">{row.explanation}</td></tr>)}</tbody></table></div>;
}

const rowClass = (status: string) => status === "Missing Data" ? "invalid-row" : status === "Not Applicable" ? "not-applicable-row" : "";
const statusClass = (status: string) => status === "Missing Data" ? "status-invalid" : status === "Not Applicable" ? "status-na" : status === "Below critical floor" ? "status-floor" : "status-valid";

export default IotKpiPageOptimized;



