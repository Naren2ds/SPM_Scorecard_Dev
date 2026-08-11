import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

const fmtPct = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "N/A" : `${(value * 100).toFixed(digits)}%`;

const bandStyles: Record<ParentScorecard["band"], { bg: string; fg: string; label: string }> = {
  Green: { bg: "#e7f6ed", fg: "#146c2e", label: "Green" },
  Amber: { bg: "#fff6df", fg: "#8a5a00", label: "Amber" },
  Red: { bg: "#ffe5e1", fg: "#a4271c", label: "Red" },
};

function bandFor(score: number): ParentScorecard["band"] {
  if (score >= 80) return "Green";
  if (score >= 60) return "Amber";
  return "Red";
}

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
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query, searchable]);

  const toggleValue = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((item) => item !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const displayLabel =
    selected.length === 0 ? "All" : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  return (
    <div className="ms-dropdown" ref={ref}>
      <span className="ms-label">{label}</span>
      <button type="button" className="ms-trigger" onClick={() => setOpen((prev) => !prev)}>
        {displayLabel} <span className="ms-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="ms-panel">
          {searchable && (
            <input
              type="text"
              className="ms-search"
              placeholder="Search..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <label className="ms-item">
            <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
            All ({options.length})
          </label>
          <div className="ms-list">
            {filtered.map((option) => (
              <label key={option} className="ms-item">
                <input
                  type="checkbox"
                  checked={selected.includes(option)}
                  onChange={() => toggleValue(option)}
                />
                {option}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [overrides, setOverrides] = useState<Record<string, Record<string, boolean>>>({});

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  useEffect(() => {
    fetchJson<{ cached_at: string | null; parent_count: number }>(`${API_BASE}/api/scorecard/cache-status`)
      .then((data) => setCacheInfo(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson<ScorecardFilterOptions>(`${API_BASE}/api/scorecard/filters`)
      .then((data) => setFilters(data))
      .catch((err) => setError(String(err)));
  }, []);

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

    fetchJson<ScorecardLeaderboardResponse>(`${API_BASE}/api/scorecard/leaderboard?${params.toString()}`, controller.signal)
      .then((data) => {
        setLeaderboard(data);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(String(err));
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

    fetchJson<ScorecardSummary>(`${API_BASE}/api/scorecard/summary?${params.toString()}`, controller.signal)
      .then(setSummary)
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err));
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

    fetchJson<ScorecardParentSearchResponse>(`${API_BASE}/api/scorecard/parents/search?${params.toString()}`, controller.signal)
      .then((data) => {
        setParentSearch(data);
        setParentSearchLoading(false);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(String(err));
          setParentSearchLoading(false);
        }
      });

    return () => controller.abort();
  }, [selZones, selCategories, debouncedSearch]);

  useEffect(() => {
    if (!leaderboard) return;
    if (leaderboard.items.length === 0) {
      setSelectedParent(null);
      return;
    }
    setSelectedParent((previous) => previous ?? leaderboard.items[0].parentSupplier);
  }, [leaderboard, setSelectedParent]);

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

    fetchJson<ParentDetailResponse>(`${API_BASE}/api/scorecard/parent?${params.toString()}`, controller.signal)
      .then((data) => {
        setParentDetail(data);
        if (!data.scorecard) {
          const fallback = leaderboard?.items[0]?.parentSupplier ?? null;
          setSelectedParent(fallback === selectedParent ? null : fallback);
        }
        setDetailLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(String(err));
        setDetailLoading(false);
      });

    return () => controller.abort();
  }, [selectedParent, selZones, selCategories, leaderboard, setSelectedParent]);

  const parentOptionNames = useMemo(() => {
    const names =
      debouncedSearch.length >= 2
        ? parentSearch?.items.map((item) => item.parentSupplier) ?? []
        : leaderboard?.items.map((item) => item.parentSupplier) ?? [];

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
  const totalExpectedKpiWeight = parentDetail?.total_expected_kpi_weight ?? 0;

  type ComputedKpi = {
    id: string;
    name: string;
    pillar: string;
    max_score: number;
    raw: number | null;
    attainment: number | null;
    earned: number | null;
    effective_earned: number;
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
    band: ParentScorecard["band"];
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

  const computed: ComputedScorecard = useMemo(() => {
    if (!selected || !parentDetail) return null;

    const pillars: ComputedPillar[] = selected.pillars.map((pillar) => {
      let earnedSum = 0;
      let maxSum = 0;

      const kpis: ComputedKpi[] = pillar.kpis.map((kpi) => {
        const hasData = kpi.earned !== null && kpi.earned !== undefined;
        const defaultApplicable = kpi.applicable;
        const userOverride = selectedParent ? (overrides[selectedParent]?.[kpi.id] as boolean | undefined) : undefined;
        const effectivelyApplicable = userOverride ?? defaultApplicable;
        const effectiveEarned = effectivelyApplicable ? (hasData ? (kpi.earned ?? 0) : 0) : 0;

        if (effectivelyApplicable) {
          earnedSum += effectiveEarned;
          maxSum += kpi.max_score;
        }

        return {
          id: kpi.id,
          name: kpi.name,
          pillar: pillar.pillar,
          max_score: kpi.max_score,
          raw: kpi.raw,
          attainment: kpi.attainment,
          earned: kpi.earned,
          effective_earned: effectiveEarned,
          has_data: hasData,
          default_applicable: defaultApplicable,
          user_override: userOverride,
          effectively_applicable: effectivelyApplicable,
        };
      });

      const pillarPct = maxSum > 0 ? earnedSum / maxSum : null;

      return {
        pillar: pillar.pillar,
        weight: pillar.weight,
        earned_points: earnedSum,
        applicable_max_points: maxSum,
        pillar_pct: pillarPct,
        weighted_contribution: pillarPct === null ? 0 : pillarPct * pillar.weight,
        status: maxSum > 0 ? "applicable" : "not_applicable",
        kpis,
      };
    });

    const weightedSum = pillars.reduce((sum, pillar) => sum + pillar.weighted_contribution, 0);
    const applicablePillarWeight = pillars.reduce(
      (sum, pillar) => (pillar.status === "applicable" ? sum + pillar.weight : sum),
      0,
    );
    const normalizedScore = applicablePillarWeight > 0 ? (weightedSum / applicablePillarWeight) * 100 : 0;
    const availableKpiWeight = pillars.reduce(
      (sum, pillar) =>
        sum +
        pillar.kpis.reduce(
          (kpiSum, kpi) =>
            kpi.effectively_applicable && kpi.has_data ? kpiSum + kpi.max_score : kpiSum,
          0,
        ),
      0,
    );
    const coverage = totalExpectedKpiWeight > 0 ? availableKpiWeight / totalExpectedKpiWeight : 0;
    const totalEarned = pillars.reduce((sum, pillar) => sum + pillar.earned_points, 0);
    const totalApplicableMax = pillars.reduce((sum, pillar) => sum + pillar.applicable_max_points, 0);

    return {
      parentSupplier: selected.parentSupplier,
      invoice_value: selected.invoice_value,
      band: bandFor(normalizedScore),
      pillars,
      weighted_sum: weightedSum,
      applicable_pillar_weight: applicablePillarWeight,
      normalized_score: normalizedScore,
      available_kpi_weight: availableKpiWeight,
      coverage_pct: coverage,
      coverage_adjusted_score: normalizedScore * coverage,
      total_earned: totalEarned,
      total_applicable_max: totalApplicableMax,
    };
  }, [selected, parentDetail, overrides, selectedParent, totalExpectedKpiWeight]);

  const overrideCount = selectedParent ? Object.keys(overrides[selectedParent] ?? {}).length : 0;

  const clearFilters = () => {
    setSelZones([]);
    setSelCategories([]);
    setSearch("");
  };

  const resetParentOverrides = () => {
    if (!selectedParent) return;
    setOverrides((previous) => {
      const copy = { ...previous };
      delete copy[selectedParent];
      return copy;
    });
  };

  const exportCsv = () => {
    const params = new URLSearchParams();
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    if (debouncedSearch) params.set("search", debouncedSearch);
    const anchor = document.createElement("a");
    anchor.href = `${API_BASE}/api/scorecard/export?${params.toString()}`;
    anchor.click();
  };

  const normalizedScoreText = computed ? computed.normalized_score.toFixed(2) : "0.00";
  const coverageText = computed ? fmtPct(computed.coverage_pct, 1) : "N/A";
  const coverageAdjustedText = computed ? computed.coverage_adjusted_score.toFixed(2) : "0.00";
  const applicablePillarWeightText = computed ? computed.applicable_pillar_weight.toFixed(1) : "0.0";
  const availableKpiWeightText = computed ? computed.available_kpi_weight.toFixed(1) : "0.0";
  const weightedContributionText = computed ? computed.weighted_sum.toFixed(2) : "0.00";

  const bannerText =
    selZones.length > 0 || selCategories.length > 0
      ? "Filtered view - scores are recomputed within scorecard-category cohorts using the selected filters. Remove the filters to return to the full category cohorts."
      : `Global view - scores from cache. Percentile ranks computed across all ${cacheInfo?.parent_count ?? "..."} parent suppliers.`;

  return (
    <div className="scorecard-page">
      <section className="scorecard-hero">
        <div className="scorecard-hero-copy">
          <p className="scorecard-eyebrow">Supplier performance overview</p>
          <h1>Normalized Supplier Scorecard</h1>
          <p className="scorecard-lead">
            Combines applicable KPI results into one weighted supplier performance score. Unavailable KPIs remain visible in the breakdown, but they stay outside the normalized denominator.
          </p>
          <div className="scorecard-definition-row">
            <div className="scorecard-definition-chip">
              <strong>Normalized Score</strong>
              <span>performance across applicable pillars</span>
            </div>
            <div className="scorecard-definition-chip">
              <strong>Coverage</strong>
              <span>completeness of the score</span>
            </div>
            <div className="scorecard-definition-chip">
              <strong>Coverage-Adjusted Score</strong>
              <span>normalized score after accounting for missing coverage</span>
            </div>
          </div>
          {error && <p className="scorecard-inline-status scorecard-inline-error">Error loading scorecard: {error}</p>}
          {loading && !leaderboard && <p className="scorecard-inline-status">Loading scorecard...</p>}
        </div>

        <div className="scorecard-hero-panel">
          <div className="scorecard-hero-metric">
            <span className="scorecard-hero-metric-label">Current normalized score</span>
            <strong
              className="scorecard-hero-score"
              style={computed ? { color: bandStyles[computed.band].fg } : undefined}
            >
              {normalizedScoreText}
            </strong>
            <span className="scorecard-hero-scale">/100</span>
          </div>
          <div className="scorecard-hero-actions">
            <button
              type="button"
              className="scorecard-primary-action"
              onClick={exportCsv}
              disabled={!summary?.filtered_parent_count}
            >
              Export CSV
            </button>
            {cacheInfo?.cached_at && (
              <p className="scorecard-cache-note">
                Cache built {new Date(cacheInfo.cached_at).toLocaleString()} - {cacheInfo.parent_count} parents
              </p>
            )}
          </div>
          <div className="scorecard-hero-reference">
            <span>Calculation reference</span>
            <p>Normalized Score = Total Weighted Contribution / Applicable Pillar Weight x 100</p>
            <p>Coverage-Adjusted Score = Normalized Score x Coverage</p>
          </div>
        </div>
      </section>

      <section className="scorecard-toolbar">
        <div className="scorecard-toolbar-filters">
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
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
        <div className="scorecard-toolbar-meta">
          <div className="scorecard-filter-summary">
            <strong>{summary?.filtered_parent_count ?? 0}</strong> suppliers
          </div>
        </div>
      </section>

      <div
        className={`scorecard-banner ${selZones.length > 0 || selCategories.length > 0 ? "is-warning" : "is-success"}`}
      >
        <strong>{selZones.length > 0 || selCategories.length > 0 ? "Filtered view - live scores." : "Global view - scores from cache."}</strong>
        <span>
          {bannerText}
          {selZones.length > 0 && (
            <>
              {" "}
              Zone filter: <strong>{selZones.join(", ")}</strong>.
            </>
          )}
          {selCategories.length > 0 && (
            <>
              {" "}
              Category filter: <strong>{selCategories.join(", ")}</strong>.
            </>
          )}
          {cacheInfo?.cached_at ? ` Last built ${new Date(cacheInfo.cached_at).toLocaleString()}.` : ""}
        </span>
      </div>

      <section className="scorecard-selector">
        <div className="scorecard-selector-copy">
          <p className="scorecard-eyebrow">Parent supplier selector</p>
          <h2>{selectedParent ?? "Choose a parent supplier"}</h2>
          <p>
            Search by name, then confirm the supplier below. The selected row drives the pillar roll-up, the normalized score, and the coverage view.
          </p>
          {selected && computed && (
            <div className="scorecard-selector-meta">
              <span className="scorecard-band" style={{ background: bandStyles[computed.band].fg, color: "#ffffff" }}>
                {bandStyles[computed.band].label}
              </span>
              <span>{selected.pillars.length} pillars</span>
              <span>{overrideCount} KPI overrides</span>
            </div>
          )}
        </div>

        <div className="scorecard-selector-controls">
          <label className="scorecard-control">
            <span>Search supplier</span>
            <input
              type="search"
              className="sc-supplier-search"
              placeholder="Type at least 2 characters"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && parentSearch?.items[0]) {
                  event.preventDefault();
                  selectSearchedParent(parentSearch.items[0].parentSupplier);
                } else if (event.key === "Escape") {
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
                    <strong>{item.normalized_score.toFixed(1)}</strong>
                  </button>
                ))}
              </div>
            ) : null}
            {search.trim().length >= 2 && parentSearchLoading ? (
              <span className="sc-parent-search-status" role="status">
                Searching...
              </span>
            ) : null}
            {search.trim().length >= 2 && !parentSearchLoading && parentSearch?.items.length === 0 ? (
              <span className="sc-parent-search-status" role="status">
                No matching parent suppliers
              </span>
            ) : null}
          </label>

          <label className="scorecard-control">
            <span>Parent supplier</span>
            <select
              className="sc-supplier-select"
              value={selectedParent ?? ""}
              onChange={(event) => setSelectedParent(event.target.value)}
            >
              {parentOptionNames.map((parentName) => (
                <option key={parentName} value={parentName}>
                  {parentName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="scorecard-selector-score">
          <span>Normalized score</span>
          <strong style={computed ? { color: bandStyles[computed.band].fg } : undefined}>{normalizedScoreText}</strong>
          <p>Performance only. Coverage stays separate.</p>
        </div>
      </section>

      <section className="scorecard-summary-grid" aria-label="Summary metrics">
        <div className="scorecard-summary-card">
          <span>Coverage</span>
          <strong>{coverageText}</strong>
          <p>Completeness of the score.</p>
        </div>
        <div className="scorecard-summary-card">
          <span>Coverage-adjusted score</span>
          <strong>{coverageAdjustedText}</strong>
          <p>Normalized score after missing coverage is applied.</p>
        </div>
        <div className="scorecard-summary-card">
          <span>Applicable pillar weight</span>
          <strong>{applicablePillarWeightText} / 100</strong>
          <p>Official denominator for the normalized score.</p>
        </div>
        <div className="scorecard-summary-card">
          <span>Available KPI weight</span>
          <strong>
            {availableKpiWeightText} / {totalExpectedKpiWeight.toFixed(1)}
          </strong>
          <p>Weight currently represented by applicable KPI data.</p>
        </div>
      </section>

      <section className="scorecard-section">
        <div className="scorecard-section-heading">
          <div>
            <p className="scorecard-eyebrow">Pillar roll-up</p>
            <h2>Earned points - pillar % - weighted contribution</h2>
          </div>
          <p className="scorecard-section-note">
            The official normalized score denominator remains applicable pillar weight.
          </p>
        </div>
        <div className="scorecard-table-frame">
          <table className="scorecard-table scorecard-pillar-table">
            <thead>
              <tr>
                <Th>Pillar</Th>
                <Th align="right">Pillar Weight</Th>
                <Th align="right">Earned KPI Points</Th>
                <Th align="right">Applicable KPI Max Points</Th>
                <Th align="right">Pillar Score %</Th>
                <Th align="right">Weighted Contribution</Th>
              </tr>
            </thead>
            <tbody>
              {computed ? (
                computed.pillars.map((pillar) => {
                  const tone =
                    pillar.pillar_pct === null
                      ? "is-neutral"
                      : pillar.pillar_pct >= 0.8
                        ? "is-good"
                        : pillar.pillar_pct >= 0.6
                          ? "is-warm"
                          : pillar.pillar_pct >= 0.3
                            ? "is-low"
                            : "is-critical";

                  return (
                    <tr key={pillar.pillar} className={pillar.status === "not_applicable" ? "is-muted" : ""}>
                      <Td>{pillar.pillar}</Td>
                      <Td align="right">{pillar.weight.toFixed(1)}</Td>
                      <Td align="right">{pillar.status === "applicable" ? pillar.earned_points.toFixed(2) : "N/A"}</Td>
                      <Td align="right">{pillar.status === "applicable" ? pillar.applicable_max_points.toFixed(1) : "N/A"}</Td>
                      <Td align="right">
                        <span className={`scorecard-pill ${tone}`}>
                          {pillar.pillar_pct === null ? "N/A" : fmtPct(pillar.pillar_pct, 1)}
                        </span>
                      </Td>
                      <Td align="right">{pillar.status === "applicable" ? pillar.weighted_contribution.toFixed(2) : "0.00"}</Td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="scorecard-empty-cell">
                    {detailLoading
                      ? "Loading parent scorecard..."
                      : "Search for and select a parent supplier to see the pillar-by-pillar breakdown."}
                  </td>
                </tr>
              )}
            </tbody>
            {computed && (
              <tfoot>
                <tr>
                  <td>Totals (applicable only)</td>
                  <td align="right">{computed.applicable_pillar_weight.toFixed(1)}</td>
                  <td align="right">{computed.total_earned.toFixed(2)}</td>
                  <td align="right">{computed.total_applicable_max.toFixed(1)}</td>
                  <td align="right">N/A</td>
                  <td align="right">{weightedContributionText}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      <section className="scorecard-strip scorecard-strip-normalized">
        <div className="scorecard-strip-heading">
          <p className="scorecard-eyebrow">Formula strip</p>
          <h2>Normalized score calculation</h2>
        </div>
        <div className="scorecard-strip-row">
          <MiniBox label="Weighted Contribution" value={weightedContributionText} />
          <div className="scorecard-strip-op">/</div>
          <MiniBox label="Applicable Pillar Weight" value={applicablePillarWeightText} />
          <div className="scorecard-strip-op">x</div>
          <MiniBox label="Scale" value="100" />
          <div className="scorecard-strip-op">=</div>
          <MiniBox label="Normalized Score" value={normalizedScoreText} highlighted />
        </div>
      </section>

      <section className="scorecard-strip scorecard-strip-coverage">
        <div className="scorecard-strip-heading">
          <p className="scorecard-eyebrow">Coverage strip</p>
          <h2>Coverage and coverage-adjusted score</h2>
        </div>
        <div className="scorecard-strip-row">
          <MiniBox label="Available KPI Weight" value={availableKpiWeightText} />
          <div className="scorecard-strip-op">/</div>
          <MiniBox label="Total Expected KPI Weight" value={totalExpectedKpiWeight.toFixed(1)} />
          <div className="scorecard-strip-op">=</div>
          <MiniBox label="Coverage" value={coverageText} />
          <div className="scorecard-strip-op">x</div>
          <MiniBox label="Normalized Score" value={normalizedScoreText} />
          <div className="scorecard-strip-op">=</div>
          <MiniBox label="Coverage-Adjusted Score" value={coverageAdjustedText} highlighted />
        </div>
      </section>

      <section className="scorecard-callout">
        <strong>Read the score in two layers.</strong>
        <span>
          Normalized score measures performance across applicable pillars. Coverage measures completeness. Coverage-adjusted score shows the normalized score after missing coverage is accounted for.
        </span>
      </section>

      <section className="scorecard-section">
        <div className="scorecard-section-heading scorecard-section-heading-row">
          <div>
            <p className="scorecard-eyebrow">KPI breakdown</p>
            <h2>Toggle Applicable? to see the live impact</h2>
          </div>
          {overrideCount > 0 && (
            <button type="button" className="scorecard-secondary-action" onClick={resetParentOverrides}>
              Reset overrides ({overrideCount})
            </button>
          )}
        </div>
        <div className="scorecard-table-frame">
          <table className="scorecard-table scorecard-kpi-table">
            <thead>
              <tr>
                <Th>Pillar</Th>
                <Th>KPI</Th>
                <Th align="right">KPI Max Points</Th>
                <Th align="right">KPI Earned Points</Th>
                <Th align="center">Applicable?</Th>
                <Th align="right">KPI Score %</Th>
              </tr>
            </thead>
            <tbody>
              {computed ? (
                computed.pillars.flatMap((pillar) =>
                  pillar.kpis.map((kpi) => {
                    const kpiPct =
                      kpi.effectively_applicable && kpi.max_score > 0
                        ? kpi.effective_earned / kpi.max_score
                        : null;
                    const isOverridden = kpi.user_override !== undefined;
                    const isMissingApplicable = kpi.effectively_applicable && !kpi.has_data;
                    const rowClass = !kpi.effectively_applicable
                      ? "is-muted"
                      : isMissingApplicable
                        ? "is-warning"
                        : "";

                    return (
                      <tr key={`${pillar.pillar}-${kpi.id}`} className={rowClass}>
                        <Td>{pillar.pillar}</Td>
                        <Td>
                          <span className="scorecard-kpi-name">{kpi.name}</span>
                          {isMissingApplicable && <span className="scorecard-tag missing">Missing data</span>}
                          {isOverridden && <span className="scorecard-tag override">Overridden</span>}
                        </Td>
                        <Td align="right">{kpi.max_score.toFixed(0)}</Td>
                        <Td align="right">{kpi.effectively_applicable ? kpi.effective_earned.toFixed(2) : "N/A"}</Td>
                        <Td align="center">
                          <select
                            className="sc-applicable-select"
                            value={kpi.effectively_applicable ? "yes" : "no"}
                            onChange={(event) => {
                              const next = event.target.value === "yes";
                              if (next === kpi.default_applicable) {
                                if (!selectedParent) return;
                                setOverrides((previous) => {
                                  const current = { ...(previous[selectedParent] ?? {}) };
                                  delete current[kpi.id];
                                  return { ...previous, [selectedParent]: current };
                                });
                              } else if (selectedParent) {
                                setOverrides((previous) => {
                                  const current = { ...(previous[selectedParent] ?? {}) };
                                  current[kpi.id] = next;
                                  return { ...previous, [selectedParent]: current };
                                });
                              }
                            }}
                          >
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        </Td>
                        <Td align="right">{kpi.effectively_applicable ? fmtPct(kpiPct, 0) : "N/A"}</Td>
                      </tr>
                    );
                  }),
                )
              ) : (
                <tr>
                  <td colSpan={6} className="scorecard-empty-cell">
                    Select a parent supplier to see the KPI breakdown.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="scorecard-footer-note">
        <strong>Pillar weights</strong>
        <span>
          {parentDetail
            ? Object.entries(parentDetail.pillar_weights)
                .map(([pillar, weight]) => `${pillar} ${weight}`)
                .join(" · ")
            : "N/A"}
        </span>
        <span>
          Coverage = Available KPI Weight / Total Expected KPI Weight ({parentDetail ? parentDetail.total_expected_kpi_weight : 0})
        </span>
      </section>
    </div>
  );
}

function SummaryCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="summary-card">
      <div className="summary-card-title">{title}</div>
      <div className="summary-card-value">{value}</div>
    </div>
  );
}

function MiniBox({
  label,
  value,
  highlighted = false,
}: {
  label: string;
  value: string;
  highlighted?: boolean;
}) {
  return (
    <div className={`mini-box ${highlighted ? "is-highlighted" : ""}`}>
      <div className="mini-box-label">{label}</div>
      <div className="mini-box-value">{value}</div>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
}) {
  return <th className={`table-head ${alignClass(align)}`}>{children}</th>;
}

function Td({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
}) {
  return <td className={`table-cell ${alignClass(align)}`}>{children}</td>;
}

function alignClass(align: "left" | "right" | "center") {
  if (align === "right") return "is-right";
  if (align === "center") return "is-center";
  return "is-left";
}

export default ScorecardPage;
