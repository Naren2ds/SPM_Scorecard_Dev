// ---------------------------------------------------------------------------
// Normalized Supplier Scorecard — consolidates all 9 KPI earned scores into
// Pillar Scores and an overall Normalized Score per Parent Supplier.
//
// Framework: docs/Supplier_Performance_Normalized_Scorecard_Framework_Report.pdf
//            §5 Recommended Framework · §6 Methodology · §7 Coverage Layer
// Mapping:   docs/Score_Card_Calculation_Proposed.xlsx  sheet "Mapping"
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "./shared/usePersistedState";
import "./styles.css";
import type {
  ParentDetailResponse,
  ParentScorecard,
  ScorecardFilterOptions,
  ScorecardLeaderboardResponse,
  ScorecardParentSearchResponse,
  ScorecardSummary,
} from "./scorecardTypes";

// ─── Number-format helpers ──────────────────────────────────────────────────

const fmtCurrencyShort = (v: number) => {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

const fmtPct = (v: number | null, digits = 1) =>
  v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

const bandStyles: Record<
  ParentScorecard["band"],
  { bg: string; fg: string; label: string }
> = {
  Green: { bg: "#e6f7ea", fg: "#146c2e", label: "Green" },
  Amber: { bg: "#fff4d6", fg: "#8a5a00", label: "Amber" },
  Red: { bg: "#ffe5e1", fg: "#a4271c", label: "Red" },
};

// ─── Multi-select dropdown (same UX as the KPI pages) ──────────────────────

function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  searchable,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query, searchable]);

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
          {searchable && (
            <input
              type="text"
              className="ms-search"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <label className="ms-item">
            <input
              type="checkbox"
              checked={selected.length === 0}
              onChange={() => onChange([])}
            />
            All ({options.length})
          </label>
          <div className="ms-list">
            {filtered.map((opt) => (
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
        </div>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

function ScorecardPage() {
  const [filters, setFilters] = useState<ScorecardFilterOptions>({
    zones: [],
    categories: [],
    parents: [],
  });
  const [selZones, setSelZones] = usePersistedState<string[]>("sc-sel-zones", []);
  const [selCategories, setSelCategories] = usePersistedState<string[]>("sc-sel-categories", []);

  const [summary, setSummary] = useState<ScorecardSummary | null>(null);
  const [leaderboard, setLeaderboard] = useState<ScorecardLeaderboardResponse | null>(null);
  const [parentSearch, setParentSearch] = useState<ScorecardParentSearchResponse | null>(null);
  const [parentSearchLoading, setParentSearchLoading] = useState(false);
  const [parentDetail, setParentDetail] = useState<ParentDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedParent, setSelectedParent] = usePersistedState<string | null>("sc-selected-parent", null);
  const [search, setSearch] = usePersistedState<string>("sc-search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [cacheInfo, setCacheInfo] = useState<{ cached_at: string | null; parent_count: number } | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  // Load cache status once on mount
  useEffect(() => {
    fetchJson<{ cached_at: string | null; parent_count: number }>(`${API_BASE}/api/scorecard/cache-status`)
      .then((data) => setCacheInfo(data))
      .catch(() => {});
  }, []);

  // Load filter options once
  useEffect(() => {
    fetchJson<ScorecardFilterOptions>(`${API_BASE}/api/scorecard/filters`)
      .then((data: ScorecardFilterOptions) => setFilters(data))
      .catch((e) => setError(String(e)));
  }, []);

  // Load scorecard whenever filters change
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    params.set("page", "1");
    params.set("page_size", "100");
    params.set("sort", "normalized_score");
    params.set("order", "desc");
    fetchJson<ScorecardLeaderboardResponse>(
      `${API_BASE}/api/scorecard/leaderboard?${params.toString()}`,
      controller.signal,
    )
      .then((data) => {
        setLeaderboard(data);
        setLoading(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(String(e));
        setLoading(false);
      });
    return () => controller.abort();
  }, [selZones, selCategories]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    if (debouncedSearch) params.set("search", debouncedSearch);
    fetchJson<ScorecardSummary>(
      `${API_BASE}/api/scorecard/summary?${params.toString()}`,
      controller.signal,
    )
      .then(setSummary)
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [selZones, selCategories, debouncedSearch]);

  useEffect(() => {
    if (debouncedSearch.length < 2) {
      setParentSearch(null);
      setParentSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    setParentSearchLoading(true);
    const params = new URLSearchParams({ q: debouncedSearch, limit: "30" });
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    fetchJson<ScorecardParentSearchResponse>(
      `${API_BASE}/api/scorecard/parents/search?${params.toString()}`,
      controller.signal,
    )
      .then((data) => {
        setParentSearch(data);
        setParentSearchLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(String(e));
          setParentSearchLoading(false);
        }
      });
    return () => controller.abort();
  }, [selZones, selCategories, debouncedSearch]);

  // Use the leading compact row only when there is no persisted selection.
  useEffect(() => {
    // A tab change remounts this page. Do not erase the persisted selection
    // while the leaderboard request is still in flight.
    if (!leaderboard) return;
    if (leaderboard.items.length === 0) {
      setSelectedParent(null);
      return;
    }
    setSelectedParent((prev) => {
      if (prev) {
        return prev;
      }
      return leaderboard.items[0].parentSupplier;
    });
  }, [leaderboard]);

  useEffect(() => {
    if (!selectedParent) {
      setParentDetail(null);
      return;
    }
    const controller = new AbortController();
    setParentDetail(null);
    setDetailLoading(true);
    const params = new URLSearchParams({ name: selectedParent });
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    fetchJson<ParentDetailResponse>(
      `${API_BASE}/api/scorecard/parent?${params.toString()}`,
      controller.signal,
    )
      .then((data) => {
        setParentDetail(data);
        if (!data.scorecard) {
          const fallback = leaderboard?.items[0]?.parentSupplier ?? null;
          setSelectedParent(fallback === selectedParent ? null : fallback);
        }
        setDetailLoading(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(String(e));
        setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedParent, selZones, selCategories, leaderboard]);

  const parentOptionNames = useMemo(() => {
    const names = debouncedSearch.length >= 2
      ? (parentSearch?.items.map((item) => item.parentSupplier) ?? [])
      : (leaderboard?.items.map((item) => item.parentSupplier) ?? []);
    if (selectedParent && !names.includes(selectedParent)) {
      return [selectedParent, ...names];
    }
    return names;
  }, [debouncedSearch, parentSearch, leaderboard, selectedParent]);

  const selectSearchedParent = (parentName: string) => {
    setSelectedParent(parentName);
    setSearch("");
    setDebouncedSearch("");
    setParentSearch(null);
    setParentSearchLoading(false);
  };

  const selected = parentDetail?.scorecard ?? null;

  // ─── User applicability overrides (per KPI, per parent) ─────────────────
  //
  // Value semantics for `overrides[kpiId]`:
  //   undefined → use the server-computed default (applicable iff data exists)
  //   true      → force "Applicable" (counts in denominator; earned = data or 0)
  //   false     → force "Not Applicable" (excluded from denominator + coverage)
  //
  // Overrides are keyed by the currently selected parent so switching rows
  // does not carry over decisions between suppliers.
  const [overrides, setOverrides] = useState<
    Record<string, Record<string, boolean>>
  >({});

  const parentOverrides = selectedParent
    ? (overrides[selectedParent] ?? {})
    : {};

  const setKpiOverride = (kpiId: string, applicable: boolean | undefined) => {
    if (!selectedParent) return;
    setOverrides((prev) => {
      const cur = { ...(prev[selectedParent] ?? {}) };
      if (applicable === undefined) {
        delete cur[kpiId];
      } else {
        cur[kpiId] = applicable;
      }
      return { ...prev, [selectedParent]: cur };
    });
  };

  const resetParentOverrides = () => {
    if (!selectedParent) return;
    setOverrides((prev) => {
      const copy = { ...prev };
      delete copy[selectedParent];
      return copy;
    });
  };

  // ─── Recompute the whole scorecard live using overrides ─────────────────
  //
  // Framework §7 semantics that this implements:
  //   - "Not Applicable" KPIs are excluded from BOTH the pillar denominator
  //     AND the coverage denominator numerator.
  //   - "Applicable but no data" (Missing Applicable) counts in the pillar
  //     denominator with earned=0 (drags the pillar score down) AND does not
  //     contribute to the coverage numerator (drags coverage % down too).
  //   - Total Expected KPI Weight = SUM(max_score) across ALL KPIs.
  //
  // Because every KPI ships in the response, the whole calculation can run
  // client-side, giving instant feedback when the user flips a dropdown.
  const totalExpectedKpiWeight =
    parentDetail?.total_expected_kpi_weight ??
    (parentDetail?.kpis.reduce((s, k) => s + k.max_score, 0) ?? 0);

  type ComputedKpi = {
    id: string;
    name: string;
    pillar: string;
    max_score: number;
    raw: number | null;
    attainment: number | null;
    earned: number | null; // original earned (null if no data)
    effective_earned: number; // 0 if applicable but missing data
    has_data: boolean;
    default_applicable: boolean;
    user_override: boolean | undefined;
    effectively_applicable: boolean;
  };

  type ComputedPillar = {
    pillar: string;
    weight: number;
    earned_points: number;
    applicable_max_points: number;
    pillar_pct: number | null;
    weighted_contribution: number;
    status: "applicable" | "not_applicable";
    kpis: ComputedKpi[];
  };

  type ComputedScorecard = {
    parentSupplier: string;
    invoice_value: number;
    band: "Green" | "Amber" | "Red";
    pillars: ComputedPillar[];
    weighted_sum: number;
    applicable_pillar_weight: number;
    normalized_score: number;
    available_kpi_weight: number;
    coverage_pct: number;
    coverage_adjusted_score: number;
    total_earned: number;
    total_applicable_max: number;
  } | null;

  const bandFor = (score: number): "Green" | "Amber" | "Red" =>
    score >= 80 ? "Green" : score >= 60 ? "Amber" : "Red";

  const computed: ComputedScorecard = useMemo(() => {
    if (!selected || !parentDetail) return null;

    const pillars: ComputedPillar[] = selected.pillars.map((p) => {
      let earnedSum = 0;
      let maxSum = 0;

      const kpis: ComputedKpi[] = p.kpis.map((k) => {
        const hasData = k.earned !== null && k.earned !== undefined;
        const defaultApplicable = k.applicable;
        const userOverride = parentOverrides[k.id];
        const effApplicable = userOverride ?? defaultApplicable;
        const effectiveEarned = effApplicable ? (hasData ? (k.earned ?? 0) : 0) : 0;

        if (effApplicable) {
          earnedSum += effectiveEarned;
          maxSum += k.max_score;
        }

        return {
          id: k.id,
          name: k.name,
          pillar: p.pillar,
          max_score: k.max_score,
          raw: k.raw,
          attainment: k.attainment,
          earned: k.earned,
          effective_earned: effectiveEarned,
          has_data: hasData,
          default_applicable: defaultApplicable,
          user_override: userOverride,
          effectively_applicable: effApplicable,
        };
      });

      const pillarPct = maxSum > 0 ? earnedSum / maxSum : null;
      return {
        pillar: p.pillar,
        weight: p.weight,
        earned_points: earnedSum,
        applicable_max_points: maxSum,
        pillar_pct: pillarPct,
        weighted_contribution: pillarPct === null ? 0 : pillarPct * p.weight,
        status: maxSum > 0 ? "applicable" : "not_applicable",
        kpis,
      };
    });

    const weightedSum = pillars.reduce(
      (s, p) => s + p.weighted_contribution,
      0,
    );
    const applicablePillarWeight = pillars.reduce(
      (s, p) => (p.status === "applicable" ? s + p.weight : s),
      0,
    );
    const normalized =
      applicablePillarWeight > 0
        ? (weightedSum / applicablePillarWeight) * 100
        : 0;
    const availableKpiWeight = pillars.reduce(
      (s, p) =>
        s +
        p.kpis.reduce(
          (ks, k) =>
            k.effectively_applicable && k.has_data ? ks + k.max_score : ks,
          0,
        ),
      0,
    );
    const coverage =
      totalExpectedKpiWeight > 0
        ? availableKpiWeight / totalExpectedKpiWeight
        : 0;
    const totalEarned = pillars.reduce((s, p) => s + p.earned_points, 0);
    const totalApplicableMax = pillars.reduce(
      (s, p) => s + p.applicable_max_points,
      0,
    );

    return {
      parentSupplier: selected.parentSupplier,
      invoice_value: selected.invoice_value,
      band: bandFor(normalized),
      pillars,
      weighted_sum: weightedSum,
      applicable_pillar_weight: applicablePillarWeight,
      normalized_score: normalized,
      available_kpi_weight: availableKpiWeight,
      coverage_pct: coverage,
      coverage_adjusted_score: normalized * coverage,
      total_earned: totalEarned,
      total_applicable_max: totalApplicableMax,
    };
  }, [selected, parentDetail, parentOverrides, totalExpectedKpiWeight]);

  const overrideCount = Object.keys(parentOverrides).length;

  const clearFilters = () => {
    setSelZones([]);
    setSelCategories([]);
    setSearch("");
  };

  const exportCsv = () => {
    const params = new URLSearchParams();
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    if (debouncedSearch) params.set("search", debouncedSearch);
    const a = document.createElement("a");
    a.href = `${API_BASE}/api/scorecard/export?${params.toString()}`;
    a.click();
  };

  return (
    <>
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Q3 Normalized Framework</p>
          <h1>Normalized Supplier Scorecard</h1>
          <p className="kpi-value-note">
            Score = Σ(Pillar&nbsp;%&nbsp;×&nbsp;Pillar&nbsp;Weight)&nbsp;/&nbsp;Σ(Applicable&nbsp;Pillar&nbsp;Weight)&nbsp;×&nbsp;100
          </p>
          <p className="kpi-value-note">
            Pillar&nbsp;% = Σ(Earned&nbsp;KPI&nbsp;Points)&nbsp;/&nbsp;Σ(Applicable&nbsp;Max&nbsp;Points)
          </p>
          {error && <p className="supporting">Error loading scorecard: {error}</p>}
          {loading && !leaderboard && <p className="supporting">Loading scorecard…</p>}
        </div>
        <div className="header-actions">
          <div style={{ textAlign: "right" }}>
            {cacheInfo?.cached_at && (
              <p className="supporting" style={{ marginBottom: "4px", fontSize: "0.75rem" }}>
                Cache built: {new Date(cacheInfo.cached_at).toLocaleString()} &nbsp;|&nbsp; {cacheInfo.parent_count} parents
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!summary?.filtered_parent_count}
          >
            Export CSV
          </button>
        </div>
      </section>

      {/* ─── Filters & summary ──────────────────────────────────────────── */}
      <section className="config-bar">
        <MultiSelectDropdown
          label="Zone"
          options={filters.zones}
          selected={selZones}
          onChange={setSelZones}
        />
        <MultiSelectDropdown
          label="Category"
          options={filters.categories}
          selected={selCategories}
          onChange={setSelCategories}
          searchable
        />
        <button type="button" onClick={clearFilters}>Clear filters</button>
        <div className="filter-summary">
          <strong>{summary?.filtered_parent_count ?? 0}</strong> suppliers
        </div>
      </section>

      {/* ─── Score mode banner ──────────────────────────────────────────── */}
      {(selZones.length > 0 || selCategories.length > 0) ? (
        <div style={{
          background: "#fff7e6",
          border: "1px solid #f5a623",
          borderRadius: "6px",
          padding: "8px 16px",
          margin: "0 0 8px 0",
          fontSize: "0.85rem",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          <span style={{ fontSize: "1rem" }}>⚠️</span>
          <span>
            <strong>Regional view — live scores.</strong>{" "}
            Scores are computed from{" "}
            {selZones.length > 0 && <><strong>{selZones.join(", ")}</strong> zone{selZones.length > 1 ? "s" : ""}</>}
            {selZones.length > 0 && selCategories.length > 0 && " · "}
            {selCategories.length > 0 && <><strong>{selCategories.join(", ")}</strong> categor{selCategories.length > 1 ? "ies" : "y"}</>}
            {" "}data only — not the global ranking. Remove zone/category filters to return to global scores.
          </span>
        </div>
      ) : (
        <div style={{
          background: "#f0f9f0",
          border: "1px solid #4caf50",
          borderRadius: "6px",
          padding: "8px 16px",
          margin: "0 0 8px 0",
          fontSize: "0.85rem",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          <span style={{ fontSize: "1rem" }}>✅</span>
          <span>
            <strong>Global view — scores from cache.</strong>{" "}
            Percentile ranks computed across all {cacheInfo?.parent_count ?? "…"} parent suppliers.
            {cacheInfo?.cached_at && <> Last built: {new Date(cacheInfo.cached_at).toLocaleString()}.</>}
          </span>
        </div>
      )}

      {/* ─── Drill-down ─────────────────────────────────────────────────── */}
      <div className="sc-body">
        <div className="sc-detail">
          {selected && computed ? (
            <>
              <div
                className="sc-detail-header"
                style={{ borderTopColor: bandStyles[computed.band].fg }}
              >
                <div>
                  <p className="eyebrow">Parent Supplier</p>
                  <div className="sc-parent-search">
                    <input
                      type="search"
                      className="sc-supplier-search"
                      placeholder="Type at least 2 characters"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && parentSearch?.items[0]) {
                          e.preventDefault();
                          selectSearchedParent(parentSearch.items[0].parentSupplier);
                        } else if (e.key === "Escape") {
                          setParentSearch(null);
                        }
                      }}
                      aria-label="Search parent suppliers"
                      aria-controls="scorecard-parent-search-results"
                      aria-expanded={Boolean(parentSearch?.items.length)}
                      autoComplete="off"
                    />
                    {parentSearch?.items.length ? (
                      <div
                        id="scorecard-parent-search-results"
                        className="sc-parent-search-results"
                        role="listbox"
                        aria-label="Matching parent suppliers"
                      >
                        {parentSearch.items.map((item) => (
                          <button
                            type="button"
                            key={item.parentSupplier}
                            onClick={() => selectSearchedParent(item.parentSupplier)}
                            role="option"
                            aria-selected={item.parentSupplier === selectedParent}
                          >
                            <span>{item.parentSupplier}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {search.trim().length >= 2 && parentSearchLoading ? (
                      <span className="sc-parent-search-status" role="status">Searching...</span>
                    ) : null}
                    {search.trim().length >= 2 && !parentSearchLoading && parentSearch?.items.length === 0 ? (
                      <span className="sc-parent-search-status" role="status">No matching parent suppliers</span>
                    ) : null}
                  </div>
                  <select
                    className="sc-supplier-select"
                    value={selectedParent ?? ""}
                    onChange={(e) => setSelectedParent(e.target.value)}
                  >
                    {parentOptionNames.map((parentName) => (
                      <option key={parentName} value={parentName}>
                        {parentName}
                      </option>
                    ))}
                  </select>
                </div>
                <div
                  className="sc-detail-score"
                  style={{ color: bandStyles[computed.band].fg }}
                >
                  {computed.normalized_score.toFixed(1)}
                  <span className="sc-detail-scale">/100</span>
                </div>
              </div>

              <div className="sc-metric-row">
                <div className="sc-metric">
                  <div className="sc-metric-label">Coverage</div>
                  <div className="sc-metric-value">
                    {fmtPct(computed.coverage_pct, 1)}
                  </div>
                </div>
                <div className="sc-metric">
                  <div className="sc-metric-label">Coverage-Adjusted</div>
                  <div className="sc-metric-value">
                    {computed.coverage_adjusted_score.toFixed(1)}
                  </div>
                </div>
                <div className="sc-metric">
                  <div className="sc-metric-label">Applicable Pillar Weight</div>
                  <div className="sc-metric-value">
                    {computed.applicable_pillar_weight.toFixed(0)}
                    <span className="sc-metric-scale"> / 100</span>
                  </div>
                </div>
                <div className="sc-metric">
                  <div className="sc-metric-label">Available KPI Weight</div>
                  <div className="sc-metric-value">
                    {computed.available_kpi_weight.toFixed(0)}
                    <span className="sc-metric-scale">
                      {" / "}
                      {totalExpectedKpiWeight.toFixed(0)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="sc-section">
                <div className="sc-section-title">
                  Pillar Roll-up · Earned Points → Pillar % → Weighted Contribution
                </div>
                <table className="sc-pillar-table">
                  <thead>
                    <tr>
                      <th>Pillar</th>
                      <th className="num">Pillar Weight</th>
                      <th className="num">Earned KPI Points</th>
                      <th className="num">Applicable KPI Max Points</th>
                      <th className="num">Pillar Score %</th>
                      <th className="num">Weighted Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computed.pillars.map((p) => {
                      const pctColor =
                        p.pillar_pct === null
                          ? "#f4f4ef"
                          : p.pillar_pct >= 0.8
                            ? "#e6f7ea"
                            : p.pillar_pct >= 0.6
                              ? "#fff8dc"
                              : p.pillar_pct >= 0.3
                                ? "#fff1d6"
                                : "#ffe5e1";
                      return (
                        <tr
                          key={p.pillar}
                          className={
                            p.status === "not_applicable" ? "sc-row-muted" : ""
                          }
                        >
                          <td className="name">{p.pillar}</td>
                          <td className="num">{p.weight.toFixed(1)}</td>
                          <td className="num">
                            {p.status === "applicable"
                              ? p.earned_points.toFixed(2)
                              : "—"}
                          </td>
                          <td className="num">
                            {p.status === "applicable"
                              ? p.applicable_max_points.toFixed(1)
                              : "—"}
                          </td>
                          <td
                            className="num"
                            style={{ background: pctColor, fontWeight: 700 }}
                          >
                            {p.pillar_pct === null
                              ? "N/A"
                              : fmtPct(p.pillar_pct, 1)}
                          </td>
                          <td className="num strong">
                            {p.status === "applicable"
                              ? p.weighted_contribution.toFixed(2)
                              : "0.00"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="name">Totals (applicable only)</td>
                      <td className="num strong">
                        {computed.applicable_pillar_weight.toFixed(1)}
                      </td>
                      <td className="num strong">
                        {computed.total_earned.toFixed(2)}
                      </td>
                      <td className="num strong">
                        {computed.total_applicable_max.toFixed(1)}
                      </td>
                      <td className="num">—</td>
                      <td className="num strong">
                        {computed.weighted_sum.toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                {/* Overall Normalized Score derivation strip */}
                <div className="sc-normcalc">
                  <div className="sc-normcalc-title">
                    Overall Normalized Supplier Score
                  </div>
                  <div className="sc-normcalc-row">
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">
                        Σ(Pillar % × Pillar Weight)
                      </div>
                      <div className="sc-normcalc-value">
                        {computed.weighted_sum.toFixed(2)}
                      </div>
                    </div>
                    <div className="sc-normcalc-op">÷</div>
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">
                        Σ(Applicable Pillar Weight)
                      </div>
                      <div className="sc-normcalc-value">
                        {computed.applicable_pillar_weight.toFixed(1)}
                      </div>
                    </div>
                    <div className="sc-normcalc-op">×</div>
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">Scale</div>
                      <div className="sc-normcalc-value">100</div>
                    </div>
                    <div className="sc-normcalc-op">=</div>
                    <div
                      className="sc-normcalc-cell final"
                      style={{ color: bandStyles[computed.band].fg }}
                    >
                      <div className="sc-normcalc-label">Final Score</div>
                      <div className="sc-normcalc-value">
                        {computed.normalized_score.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Coverage derivation strip */}
                <div className="sc-normcalc sc-normcalc-coverage">
                  <div className="sc-normcalc-title sc-cov-title">
                    Coverage &amp; Coverage-Adjusted Score
                  </div>
                  <div className="sc-normcalc-row">
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">
                        Available KPI Weight
                      </div>
                      <div className="sc-normcalc-value">
                        {computed.available_kpi_weight.toFixed(1)}
                      </div>
                    </div>
                    <div className="sc-normcalc-op">÷</div>
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">
                        Total Expected KPI Weight
                      </div>
                      <div className="sc-normcalc-value">
                        {totalExpectedKpiWeight.toFixed(1)}
                      </div>
                    </div>
                    <div className="sc-normcalc-op">=</div>
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">Coverage %</div>
                      <div className="sc-normcalc-value">
                        {fmtPct(computed.coverage_pct, 1)}
                      </div>
                    </div>
                    <div className="sc-normcalc-op">×</div>
                    <div className="sc-normcalc-cell">
                      <div className="sc-normcalc-label">Normalized Score</div>
                      <div className="sc-normcalc-value">
                        {computed.normalized_score.toFixed(2)}
                      </div>
                    </div>
                    <div className="sc-normcalc-op">=</div>
                    <div className="sc-normcalc-cell final">
                      <div className="sc-normcalc-label">Coverage-Adjusted</div>
                      <div className="sc-normcalc-value">
                        {computed.coverage_adjusted_score.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="sc-section">
                <div className="sc-section-title sc-kpi-title-row">
                  <span>KPI Breakdown · Toggle Applicable? to see live impact</span>
                  {overrideCount > 0 && (
                    <button
                      type="button"
                      className="sc-btn ghost sc-reset-btn"
                      onClick={resetParentOverrides}
                    >
                      Reset overrides ({overrideCount})
                    </button>
                  )}
                </div>
                <table className="sc-kpi-table">
                  <thead>
                    <tr>
                      <th>Pillar</th>
                      <th>KPI</th>
                      <th className="num">KPI Max Points</th>
                      <th className="num">KPI Earned Points</th>
                      <th>Applicable?</th>
                      <th className="num">KPI Score %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computed.pillars.flatMap((p) =>
                      p.kpis.map((k) => {
                        const kpiPct =
                          k.effectively_applicable && k.max_score > 0
                            ? k.effective_earned / k.max_score
                            : null;
                        const isOverridden = k.user_override !== undefined;
                        const isMissingApplicable =
                          k.effectively_applicable && !k.has_data;
                        const rowClass = !k.effectively_applicable
                          ? "sc-row-muted"
                          : isMissingApplicable
                            ? "sc-row-warn"
                            : "";
                        return (
                          <tr key={`${p.pillar}-${k.id}`} className={rowClass}>
                            <td>{p.pillar}</td>
                            <td className="name">
                              {k.name}
                              {isMissingApplicable && (
                                <span
                                  className="sc-tag missing"
                                  title="Marked Applicable but no source data — earned = 0, hurts pillar score and coverage."
                                >
                                  Missing data
                                </span>
                              )}
                              {isOverridden && (
                                <span
                                  className="sc-tag override"
                                  title="You overrode the default applicability for this KPI."
                                >
                                  Overridden
                                </span>
                              )}
                            </td>
                            <td className="num">{k.max_score.toFixed(0)}</td>
                            <td className="num strong">
                              {k.effectively_applicable
                                ? k.effective_earned.toFixed(2)
                                : "—"}
                            </td>
                            <td>
                              <select
                                className="sc-applicable-select"
                                value={k.effectively_applicable ? "yes" : "no"}
                                onChange={(e) => {
                                  const next = e.target.value === "yes";
                                  // If user picks the default value, clear
                                  // the override so it tracks defaults again.
                                  if (next === k.default_applicable) {
                                    setKpiOverride(k.id, undefined);
                                  } else {
                                    setKpiOverride(k.id, next);
                                  }
                                }}
                              >
                                <option value="yes">Yes</option>
                                <option value="no">No</option>
                              </select>
                            </td>
                            <td className="num">
                              {k.effectively_applicable
                                ? fmtPct(kpiPct, 0)
                                : "—"}
                            </td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="sc-detail-empty">
              <p>{detailLoading ? "Loading parent scorecard..." : "Search for and select a parent supplier to see the pillar-by-pillar breakdown."}</p>
            </div>
          )}
        </div>
      </div>

      {/* ─── Framework footer ────────────────────────────────────────────── */}
      <section className="config-bar">
        <div className="filter-summary">
          <strong>Pillar Weights:</strong>{" "}
          {parentDetail
            ? Object.entries(parentDetail.pillar_weights)
                .map(([p, w]) => `${p} ${w}`)
                .join(" · ")
            : "—"}
          &nbsp;·&nbsp;
          <strong>Coverage %</strong> = Available KPI Weight / Total Expected KPI Weight ({parentDetail ? parentDetail.total_expected_kpi_weight : 0})
          &nbsp;·&nbsp;
          <strong>Coverage-Adjusted</strong> = Normalized × Coverage %
        </div>
      </section>
    </>
  );
}

export default ScorecardPage;
