import { useDeferredValue, useEffect, useState } from "react";
import { MultiSelectDropdown } from "../shared/MultiSelectDropdown";
import { FixedMaxScore, ScoringConfigHeading } from "../shared/ScoringConfig";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

type DotLevel = "parent" | "supplier" | "zone" | "category";
type FormulaMode = "softStretch" | "strict";

interface DotConfig {
  maxScore: number;
  criticalFloor: number;
  target: number;
  formulaMode: FormulaMode;
}

interface DotFilterOptions {
  categories: string[];
  scorecardCategories: string[];
  years: string[];
  months: string[];
  countries: string[];
  zones: string[];
}

interface DotResult {
  id: string;
  level: DotLevel;
  label: string;
  supplier?: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category?: string;
  scorecardCategory: string;
  onTimePoLines: number | null;
  totalDeliveredPoLines: number | null;
  x1DelayedOver30Days: number | null;
  x2EarlyOver30Days: number | null;
  normalizedDot: number | null;
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

interface DotResultsResponse {
  items: DotResult[];
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  level: DotLevel;
}

interface DotSummary {
  source_row_count: number;
  cohort_row_count: number;
  result_count: number;
  valid_result_count: number;
  average_dot_pct: number;
  average_earned_score: number;
  status_counts: Record<string, number>;
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

interface DotKpiPageProps {
  sharedParent: string[];
  onParentChange: (values: string[]) => void;
}

const EMPTY_FILTERS: DotFilterOptions = {
  categories: [], scorecardCategories: [], years: [], months: [], countries: [], zones: [],
};

const DEFAULT_CONFIG: DotConfig = {
  maxScore: 10,
  criticalFloor: 0.7,
  target: 0.85,
  formulaMode: "softStretch",
};

const LEVELS: Array<{ id: DotLevel; label: string; note: string }> = [
  { id: "parent", label: "Parent Rollup", note: "Default" },
  { id: "supplier", label: "Supplier Detail", note: "On demand" },
  { id: "zone", label: "Zone Rollup", note: "On demand" },
  { id: "category", label: "Category Rollup", note: "On demand" },
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || body.message || `Request failed (${response.status})`);
  }
  return body as T;
}

function appendList(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, values.join(","));
}

function contextParams(
  categories: string[],
  scorecardCategories: string[],
  years: string[],
  months: string[],
  countries: string[],
  zones: string[],
) {
  const params = new URLSearchParams();
  appendList(params, "categories", categories);
  appendList(params, "scorecard_categories", scorecardCategories);
  appendList(params, "years", years);
  appendList(params, "months", months);
  appendList(params, "countries", countries);
  appendList(params, "zones", zones);
  return params;
}

function validateConfig(config: DotConfig) {
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

function DotKpiPageOptimized({ sharedParent, onParentChange }: DotKpiPageProps) {
  const [filterOptions, setFilterOptions] = useState<DotFilterOptions>(EMPTY_FILTERS);
  const [categories, setCategories] = useState<string[]>([]);
  const [scorecardCategories, setScorecardCategories] = useState<string[]>([]);
  const [years, setYears] = useState<string[]>(["2025", "2026"]);
  const [months, setMonths] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [level, setLevel] = useState<DotLevel>("parent");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<DotResultsResponse | null>(null);
  const [summary, setSummary] = useState<DotSummary | null>(null);
  const [savedConfig, setSavedConfig] = useState<DotConfig>(DEFAULT_CONFIG);
  const [draftConfig, setDraftConfig] = useState<DotConfig>(DEFAULT_CONFIG);
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
  const cohortSignature = JSON.stringify([categories, scorecardCategories, years, months, countries, zones]);
  const draftSignature = JSON.stringify(draftConfig);
  const savedSignature = JSON.stringify(savedConfig);
  const configErrors = validateConfig(draftConfig);
  const previewIsActive = preview?.cohortSignature === cohortSignature && preview.configSignature === draftSignature;
  const activePreviewId = previewIsActive && preview ? preview.id : null;
  const hasDraftChanges = draftSignature !== savedSignature;

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchJson<{ config: DotConfig }>(`${API_BASE}/api/dot/config`, { signal: controller.signal }),
      fetchJson<DotFilterOptions>(`${API_BASE}/api/dot/filters`, { signal: controller.signal }),
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
    const params = contextParams(categories, scorecardCategories, years, months, countries, zones);
    params.set("level", level);
    params.set("page", String(page));
    params.set("page_size", "100");
    params.set("sort", "rankDescending");
    params.set("order", "asc");
    appendList(params, "parents", sharedParent);
    if (suppliers.length > 0 && level === "supplier") appendList(params, "suppliers", suppliers);
    if (deferredResultQuery.trim()) params.set("search", deferredResultQuery.trim());
    if (activePreviewId) params.set("preview_id", activePreviewId);

    const summaryParams = contextParams(categories, scorecardCategories, years, months, countries, zones);
    summaryParams.set("level", level);
    appendList(summaryParams, "parents", sharedParent);
    if (activePreviewId) summaryParams.set("preview_id", activePreviewId);

    setLoading(true);
    setError("");
    Promise.all([
      fetchJson<DotResultsResponse>(`${API_BASE}/api/dot/results?${params}`, { signal: controller.signal }),
      fetchJson<DotSummary>(`${API_BASE}/api/dot/summary?${summaryParams}`, { signal: controller.signal }),
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
  }, [level, page, categories, scorecardCategories, years, months, countries, zones, sharedParent, suppliers, deferredResultQuery, activePreviewId]);

  useEffect(() => {
    if (deferredParentQuery.trim().length < 2) {
      setParentMatches([]);
      return;
    }
    const controller = new AbortController();
    const params = contextParams(categories, scorecardCategories, years, months, countries, zones);
    params.set("level", "parent");
    params.set("q", deferredParentQuery.trim());
    params.set("limit", "30");
    if (activePreviewId) params.set("preview_id", activePreviewId);
    fetchJson<{ items: SearchResult[] }>(`${API_BASE}/api/dot/search?${params}`, { signal: controller.signal })
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
    const params = contextParams(categories, scorecardCategories, years, months, countries, zones);
    params.set("level", "supplier");
    params.set("q", deferredSupplierQuery.trim());
    params.set("limit", "30");
    appendList(params, "parents", sharedParent);
    if (activePreviewId) params.set("preview_id", activePreviewId);
    fetchJson<{ items: SearchResult[] }>(`${API_BASE}/api/dot/search?${params}`, { signal: controller.signal })
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
    setMessage("Building a temporary preview for this full cohort...");
    setError("");
    try {
      const response = await fetchJson<{ previewId: string }>(`${API_BASE}/api/dot/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draftConfig, maxScore: savedConfig.maxScore, filters: { categories, scorecardCategories, years, months, countries, zones } }),
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
    if (preview) await fetch(`${API_BASE}/api/dot/preview/${preview.id}`, { method: "DELETE" }).catch(() => undefined);
    setPreview(null);
    setDraftConfig(savedConfig);
    setPage(1);
    setMessage("Preview discarded. Showing official saved results.");
  };

  const applyPreview = async () => {
    if (!previewIsActive || draftConfig.formulaMode !== "softStretch" || configErrors.length > 0) return;
    setScenarioBusy(true);
    setMessage("Applying Soft Stretch settings and rebuilding the official scorecard...");
    setError("");
    try {
      await fetchJson(`${API_BASE}/api/scorecard/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpiId: "DOT", floor: draftConfig.criticalFloor, target: draftConfig.target }),
      });
      const applied = { ...draftConfig, maxScore: savedConfig.maxScore, formulaMode: "softStretch" as const };
      setSavedConfig(applied);
      setDraftConfig(applied);
      setPreview(null);
      setPage(1);
      setMessage("Soft Stretch settings applied to the official scorecard.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Apply failed.");
      setMessage("");
    } finally {
      setScenarioBusy(false);
    }
  };

  const exportResults = () => {
    const params = contextParams(categories, scorecardCategories, years, months, countries, zones);
    appendList(params, "parents", sharedParent);
    appendList(params, "suppliers", suppliers);
    if (activePreviewId) params.set("preview_id", activePreviewId);
    window.location.assign(`${API_BASE}/api/dot/export?${params}`);
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
          <p className="eyebrow">Delivery KPI</p>
          <h1>DOT Percentile Scoring</h1>
          <p className="kpi-value-note">Parent Rollup loads first. Supplier, Zone, and Category results are calculated only when opened.</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={exportResults} disabled={loading || !results?.total_items}>Export Supplier CSV</button>
        </div>
      </section>

      <section className="config-bar">
        <MultiSelectDropdown label="Category" options={filterOptions.categories} selected={categories} onChange={(values) => { setCategories(values); setPage(1); }} />
        <MultiSelectDropdown label="SPM Category" options={filterOptions.scorecardCategories} selected={scorecardCategories} onChange={(values) => { setScorecardCategories(values); setPage(1); }} />
        <MultiSelectDropdown label="Year" options={filterOptions.years} selected={years} onChange={(values) => { setYears(values); setPage(1); }} />
        <MultiSelectDropdown label="Month" options={filterOptions.months} selected={months} onChange={(values) => { setMonths(values); setPage(1); }} />
        <MultiSelectDropdown label="Zone" options={filterOptions.zones} selected={zones} onChange={(values) => { setZones(values); setPage(1); }} />
        <MultiSelectDropdown label="Country" options={filterOptions.countries} selected={countries} onChange={(values) => { setCountries(values); setPage(1); }} />
        <div className="filter-summary"><strong>{summary?.cohort_row_count.toLocaleString() ?? "-"}</strong> cohort rows</div>
      </section>

      <section className="dot-entity-filters" aria-label="Display filters">
        <EntitySearch
          label="Find Parent Supplier" query={parentQuery} setQuery={setParentQuery} matches={parentMatches} selected={sharedParent}
          onSelect={selectParent}
          onRemove={(value) => { onParentChange(sharedParent.filter((item) => item !== value)); setSuppliers([]); setPage(1); }}
        />
        {level === "supplier" && (
          <EntitySearch
            label="Find Supplier" query={supplierQuery} setQuery={setSupplierQuery} matches={supplierMatches} selected={suppliers}
            onSelect={selectSupplier}
            onRemove={(value) => { setSuppliers(suppliers.filter((item) => item !== value)); setPage(1); }}
          />
        )}
        <p className="supporting">Parent rank stays against the full parent cohort. Supplier Detail shows the selected parent's rows with global supplier ranks. Zone and Category are recalculated from the selected parent's rows.</p>
      </section>

      <section className="config-bar dot-scenario-config">
        <ScoringConfigHeading />
        <FixedMaxScore value={savedConfig.maxScore} />
        <label><span>Critical Floor %</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(draftConfig.criticalFloor) ? Number((draftConfig.criticalFloor * 100).toFixed(4)) : ""} onChange={(event) => updateConfigNumber("criticalFloor", event.target.value, 100)} /></label>
        <label><span>Target %</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(draftConfig.target) ? Number((draftConfig.target * 100).toFixed(4)) : ""} onChange={(event) => updateConfigNumber("target", event.target.value, 100)} /></label>
        <label><span>Formula Mode</span><input className="fixed-config-value" type="text" value="Soft Stretch (official)" readOnly aria-readonly="true" /></label>
        <div className="dot-scenario-actions">
          <button type="button" onClick={runPreview} disabled={scenarioBusy || configErrors.length > 0}>Preview</button>
          <button type="button" onClick={applyPreview} disabled={scenarioBusy || !previewIsActive || !hasDraftChanges || draftConfig.formulaMode !== "softStretch"}>Apply to Scorecard</button>
          {preview && <button type="button" className="ghost-button" onClick={discardPreview} disabled={scenarioBusy}>Discard</button>}
        </div>
        {configErrors.length > 0 && <div className="validation-box config-bar-errors">{configErrors.map((item) => <p key={item}>{item}</p>)}</div>}
      </section>

      <section className={`dot-scenario-banner ${previewIsActive ? "is-preview" : "is-saved"}`}>
        <strong>{previewIsActive ? "Temporary preview" : "Official saved results"}</strong>
        <span>{previewIsActive ? "Soft Stretch scenario is active. Nothing has been saved." : hasDraftChanges ? "Configuration was edited. Run Preview to recalculate; the table still shows saved results." : "Soft Stretch is the production scorecard formula."}</span>
        {message && <span>{message}</span>}
      </section>

      <section className="dot-summary-grid">
        <SummaryCard label="Source rows" value={summary?.source_row_count.toLocaleString() ?? "-"} />
        <SummaryCard label="Global comparison cohort" value={summary?.cohort_row_count.toLocaleString() ?? "-"} />
        <SummaryCard label={`Displayed ${level} rows`} value={summary?.result_count.toLocaleString() ?? "-"} />
        <SummaryCard label="Contributing rows" value={summary?.valid_result_count.toLocaleString() ?? "-"} />
        <SummaryCard label="Average DOT" value={summary ? `${summary.average_dot_pct.toFixed(2)}%` : "-"} />
        <SummaryCard label="Average earned" value={summary ? summary.average_earned_score.toFixed(2) : "-"} />
      </section>

      <details className="formula-panel collapsible-section">
        <summary>How DOT Earned Score Is Calculated</summary>
        <div className="formula-ribbon" aria-label="DOT formula summary">
          <div><span>DOT</span><strong>On-Time / (Delivered + 0.99 x Late + 0.10 x Early)</strong></div>
          <div><span>Attainment</span><strong>(DOT - Floor) / (Target - Floor), limited to 0-1</strong></div>
          <div><span>Official earned score</span><strong>Max x Attainment x (70% + 30% x Percentile)</strong></div>
        </div>
        <p>Soft Stretch uses Max x Attainment x (70% + 30% x Percentile). Not Applicable and invalid rows are excluded rather than treated as zero.</p>
      </details>

      <section className="results-panel">
        <div className="dot-level-tabs" role="tablist" aria-label="DOT result level">
          {LEVELS.map((item) => (
            <button type="button" role="tab" aria-selected={level === item.id} className={level === item.id ? "is-active" : ""} key={item.id} onClick={() => { setLevel(item.id); setPage(1); setResultQuery(""); }}>
              <strong>{item.label}</strong><span>{item.note}</span>
            </button>
          ))}
        </div>
        <div className="dot-results-toolbar">
          <div>
            <h2>{LEVELS.find((item) => item.id === level)?.label}</h2>
            <p className="supporting">{results ? `${results.total_items.toLocaleString()} matching results. Page ${results.page} of ${Math.max(results.total_pages, 1)}.` : "Loading results..."}</p>
          </div>
          <label><span>Search this level</span><input value={resultQuery} onChange={(event) => { setResultQuery(event.target.value); setPage(1); }} placeholder="Type a name" /></label>
        </div>

        {error ? <div className="validation-box"><p>{error}</p></div> : loading ? (
          <div className="empty-state">Loading the selected result level...</div>
        ) : !results?.items.length ? (
          <div className="empty-state">No DOT results match these filters.</div>
        ) : <DotResultsTable rows={results.items} level={level} />}

        <div className="dot-pagination">
          <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1}>Previous</button>
          <span>Page {results?.page ?? page} / {Math.max(results?.total_pages ?? 1, 1)}</span>
          <button type="button" onClick={() => setPage((current) => current + 1)} disabled={loading || !results || page >= results.total_pages}>Next</button>
        </div>
      </section>
    </>
  );
}

function EntitySearch({ label, query, setQuery, matches, selected, onSelect, onRemove }: {
  label: string;
  query: string;
  setQuery: (value: string) => void;
  matches: SearchResult[];
  selected: string[];
  onSelect: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  return (
    <div className="dot-entity-search">
      <label><span>{label}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type at least 2 characters" /></label>
      {matches.length > 0 && <div className="dot-search-results">{matches.map((item) => (
        <button type="button" key={`${item.parentSupplier ?? ""}-${item.label}`} onClick={() => onSelect(item.label)}>{item.label}{item.parentSupplier ? <small>{item.parentSupplier}</small> : null}</button>
      ))}</div>}
      {selected.length > 0 && <div className="dot-selection-chips">{selected.map((item) => (
        <button type="button" key={item} onClick={() => onRemove(item)} title={`Remove ${item}`}>{item} <span aria-hidden="true">x</span></button>
      ))}</div>}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function DotResultsTable({ rows, level }: { rows: DotResult[]; level: DotLevel }) {
  const supplierLevel = level === "supplier";
  return (
    <div className="table-frame rollup-scroll">
      <table className="data-table results-table">
        <thead><tr>
          <th>{supplierLevel ? "Supplier" : level === "parent" ? "Parent Supplier" : level === "zone" ? "Zone" : "Category"}</th>
          <th>SPM Category</th>
          {supplierLevel && <><th>Parent</th><th>Zone</th><th>Country</th><th>Category</th></>}
          <th>On-Time</th><th>Delivered</th><th>X1 Late</th><th>X2 Early</th><th>DOT %</th><th>Rank</th><th>Percentile</th><th>Attainment</th><th>Max</th><th>Earned</th><th>Score %</th><th>Status</th><th>Contributing Rows</th><th>Explanation</th>
        </tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id} className={rowClass(row.scoreStatus)}>
            <td>{row.label}</td>
            <td>{row.scorecardCategory}</td>
            {supplierLevel && <><td>{row.parentSupplier}</td><td>{row.zone}</td><td>{row.country}</td><td>{row.category}</td></>}
            <td>{numeric(row.onTimePoLines, 0)}</td><td>{numeric(row.totalDeliveredPoLines, 0)}</td><td>{numeric(row.x1DelayedOver30Days, 0)}</td><td>{numeric(row.x2EarlyOver30Days, 0)}</td>
            <td>{percent(row.normalizedDot)}</td><td>{rank(row.rankDescending)}</td><td>{percent(row.percentile)}</td><td>{numeric(row.attainmentFactor, 4)}</td><td>{numeric(row.maxScore)}</td><td>{numeric(row.earnedScore)}</td><td>{percent(row.scorePercent)}</td>
            <td><span className={`status-pill ${statusClass(row.scoreStatus)}`}>{row.scoreStatus}</span></td><td>{row.contributingRows}</td><td className="explanation-cell">{row.explanation}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const rowClass = (status: string) => status === "Invalid DOT" ? "invalid-row" : status === "Not applicable" ? "not-applicable-row" : "";
const statusClass = (status: string) => {
  if (status === "Invalid DOT") return "status-invalid";
  if (status === "Not applicable") return "status-na";
  if (status === "Below critical floor" || status === "Zero DOT") return "status-floor";
  if (status === "No variance" || status === "Single observation") return "status-note";
  return "status-valid";
};

export default DotKpiPageOptimized;



