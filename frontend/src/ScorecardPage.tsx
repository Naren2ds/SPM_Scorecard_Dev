// ---------------------------------------------------------------------------
// Normalized Supplier Scorecard — consolidates all 9 KPI earned scores into
// Pillar Scores and an overall Normalized Score per Parent Supplier.
//
// Framework: docs/Supplier_Performance_Normalized_Scorecard_Framework_Report.pdf
//            §5 Recommended Framework · §6 Methodology · §7 Coverage Layer
// Mapping:   docs/Score_Card_Calculation_Proposed.xlsx  sheet "Mapping"
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ParentScorecard,
  ScorecardFilterOptions,
  ScorecardResponse,
} from "./scorecardTypes";

// ─── Number-format helpers (Top-N table shows invoice values in $M / $K) ──

const fmtCurrencyShort = (v: number) => {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
};

const TOP_N = 20;

const API_BASE = "http://127.0.0.1:8000";

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
  const [selZones, setSelZones] = useState<string[]>([]);
  const [selCategories, setSelCategories] = useState<string[]>([]);
  const [selParents, setSelParents] = useState<string[]>([]);

  const [scorecard, setScorecard] = useState<ScorecardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Load filter options once
  useEffect(() => {
    fetch(`${API_BASE}/api/scorecard/filters`)
      .then((res) => res.json())
      .then((data: ScorecardFilterOptions) => setFilters(data))
      .catch((e) => setError(String(e)));
  }, []);

  // Load scorecard whenever filters change
  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("top_n", String(TOP_N));
    if (selZones.length) params.set("zones", selZones.join(","));
    if (selCategories.length) params.set("categories", selCategories.join(","));
    if (selParents.length) params.set("parents", selParents.join(","));
    const url = `${API_BASE}/api/scorecard?${params.toString()}`;
    fetch(url)
      .then((res) => res.json())
      .then((data: ScorecardResponse) => {
        setScorecard(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [selZones, selCategories, selParents]);

  // Derived: filtered list based on search box + summary metrics
  const filteredScorecards = useMemo(() => {
    if (!scorecard) return [];
    const q = search.trim().toLowerCase();
    if (!q) return scorecard.scorecards;
    return scorecard.scorecards.filter((s) =>
      s.parentSupplier.toLowerCase().includes(q),
    );
  }, [scorecard, search]);

  const summary = useMemo(() => {
    if (!filteredScorecards.length) {
      return { count: 0, avgNorm: 0, avgCov: 0, greens: 0, ambers: 0, reds: 0 };
    }
    const norm =
      filteredScorecards.reduce((s, r) => s + r.normalized_score, 0) /
      filteredScorecards.length;
    const cov =
      filteredScorecards.reduce((s, r) => s + r.coverage_pct, 0) /
      filteredScorecards.length;
    const greens = filteredScorecards.filter((r) => r.band === "Green").length;
    const ambers = filteredScorecards.filter((r) => r.band === "Amber").length;
    const reds = filteredScorecards.filter((r) => r.band === "Red").length;
    return {
      count: filteredScorecards.length,
      avgNorm: norm,
      avgCov: cov,
      greens,
      ambers,
      reds,
    };
  }, [filteredScorecards]);

  // Auto-select first result when scorecard loads or filters change
  useEffect(() => {
    if (filteredScorecards.length > 0 && !selectedParent) {
      setSelectedParent(filteredScorecards[0].parentSupplier);
    } else if (
      filteredScorecards.length > 0 &&
      selectedParent &&
      !filteredScorecards.some((s) => s.parentSupplier === selectedParent)
    ) {
      setSelectedParent(filteredScorecards[0].parentSupplier);
    } else if (filteredScorecards.length === 0) {
      setSelectedParent(null);
    }
  }, [filteredScorecards, selectedParent]);

  const selected = useMemo(
    () =>
      scorecard?.scorecards.find((s) => s.parentSupplier === selectedParent) ??
      null,
    [scorecard, selectedParent],
  );

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
    scorecard?.total_expected_kpi_weight ??
    (scorecard?.kpis.reduce((s, k) => s + k.max_score, 0) ?? 0);

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
    if (!selected || !scorecard) return null;

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
  }, [selected, scorecard, parentOverrides, totalExpectedKpiWeight]);

  const overrideCount = Object.keys(parentOverrides).length;

  const clearFilters = () => {
    setSelZones([]);
    setSelCategories([]);
    setSelParents([]);
    setSearch("");
  };

  const exportCsv = () => {
    if (!scorecard) return;
    const header = [
      "Parent Supplier",
      "Normalized Score",
      "Coverage %",
      "Coverage-Adjusted",
      "Band",
      ...scorecard.kpis.flatMap((k) => [
        `${k.name} — Earned`,
        `${k.name} — Max`,
      ]),
      "Service Level %",
      "Operational %",
      "Sustainability %",
      "Value Creation %",
    ];
    const rows = filteredScorecards.map((s) => {
      const kpiCols = scorecard.kpis.flatMap((k) => {
        const found = s.pillars
          .flatMap((p) => p.kpis)
          .find((x) => x.id === k.id);
        return [
          found?.earned === null || found?.earned === undefined
            ? ""
            : found.earned.toFixed(3),
          k.max_score.toFixed(1),
        ];
      });
      const pctFor = (name: string) => {
        const p = s.pillars.find((pp) => pp.pillar === name);
        return p && p.pillar_pct !== null ? (p.pillar_pct * 100).toFixed(2) : "";
      };
      return [
        s.parentSupplier,
        s.normalized_score.toFixed(2),
        (s.coverage_pct * 100).toFixed(2),
        s.coverage_adjusted_score.toFixed(2),
        s.band,
        ...kpiCols,
        pctFor("Service Level"),
        pctFor("Operational"),
        pctFor("Sustainability"),
        pctFor("Value Creation"),
      ];
    });
    const csv = [header, ...rows]
      .map((r) =>
        r
          .map((v) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `normalized_scorecard_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="scorecard-page">
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <header className="sc-header">
        <div>
          <p className="eyebrow">
            Q3 Normalized Framework · Top {TOP_N} by Invoice Value
          </p>
          <h1>Normalized Supplier Scorecard</h1>
          <p className="kpi-definition">
            Rolls each supplier&apos;s applicable KPI earned points into pillar
            scores, then into a single 0–100 normalized score. Non-applicable
            KPIs are excluded from the denominator; missing coverage is surfaced
            separately so it never silently rewards incomplete suppliers. To
            keep the view responsive we currently rank on aggregated invoice
            value (from Price Divergence) and show the top&nbsp;{TOP_N}.
          </p>
        </div>
        <div className="sc-formula-card">
          <div className="sc-formula-title">Core Formula</div>
          <div className="sc-formula">
            Normalized Score =<br />
            <span className="mono">
              Σ(Pillar % × Pillar Weight) / Σ(Applicable Pillar Weight) × 100
            </span>
          </div>
          <div className="sc-formula-sub">
            Pillar % = Σ(Earned KPI Points) / Σ(Applicable Max Points)
          </div>
        </div>
      </header>

      {/* ─── Filters strip ───────────────────────────────────────────────── */}
      <div className="sc-filter-strip">
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
        <MultiSelectDropdown
          label="Parent Supplier"
          options={filters.parents}
          selected={selParents}
          onChange={setSelParents}
          searchable
        />
        <div className="sc-filter-search">
          <input
            type="search"
            className="sc-search"
            placeholder="Search leaderboard…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sc-filter-actions">
          <button type="button" className="sc-btn ghost" onClick={clearFilters}>
            Clear filters
          </button>
          <button
            type="button"
            className="sc-btn primary"
            onClick={exportCsv}
            disabled={!filteredScorecards.length}
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && <p className="sc-error">Error loading scorecard: {error}</p>}
      {loading && !scorecard && <p className="sc-loading">Loading scorecard…</p>}

      {/* ─── Summary strip ───────────────────────────────────────────────── */}
      <div className="sc-summary-strip">
        <div className="sc-summary-tile">
          <div className="sc-summary-label">Parents in view</div>
          <div className="sc-summary-value">{summary.count.toLocaleString()}</div>
        </div>
        <div className="sc-summary-tile">
          <div className="sc-summary-label">Avg normalized</div>
          <div className="sc-summary-value">
            {summary.count ? summary.avgNorm.toFixed(1) : "—"}
          </div>
        </div>
        <div className="sc-summary-tile">
          <div className="sc-summary-label">Avg coverage</div>
          <div className="sc-summary-value">
            {summary.count ? fmtPct(summary.avgCov, 1) : "—"}
          </div>
        </div>
        <div className="sc-summary-tile">
          <div className="sc-summary-label">Band distribution</div>
          <div className="sc-summary-value sc-band-line">
            <span className="sc-band-chip green">{summary.greens} G</span>
            <span className="sc-band-chip amber">{summary.ambers} A</span>
            <span className="sc-band-chip red">{summary.reds} R</span>
          </div>
        </div>
      </div>

      {/* ─── Main split: leaderboard + drill-down ────────────────────────── */}
      <div className="sc-body">
        {/* Leaderboard */}
        <div className="sc-leaderboard">
          <div className="sc-leaderboard-head">
            <div>
              <h2>Top {TOP_N} by Invoice Value</h2>
              <p className="sc-leaderboard-sub">
                Ranked by aggregated invoice value (price_divergence). Filters
                narrow the ranking universe before Top&nbsp;{TOP_N} is taken.
              </p>
            </div>
            <span className="sc-count">
              {filteredScorecards.length.toLocaleString()} shown
            </span>
          </div>
          <div className="sc-leaderboard-scroll">
            <table className="sc-table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>#</th>
                  <th>Parent Supplier</th>
                  <th className="num">Invoice&nbsp;Val</th>
                  <th className="num">Norm</th>
                  <th className="num">Cov&nbsp;%</th>
                  <th className="num">Adj</th>
                  <th style={{ width: 70 }}>Band</th>
                </tr>
              </thead>
              <tbody>
                {filteredScorecards.map((row, idx) => {
                  const active = row.parentSupplier === selectedParent;
                  return (
                    <tr
                      key={row.parentSupplier}
                      className={active ? "sc-row active" : "sc-row"}
                      onClick={() => setSelectedParent(row.parentSupplier)}
                    >
                      <td className="num">{idx + 1}</td>
                      <td className="name" title={row.parentSupplier}>
                        {row.parentSupplier}
                      </td>
                      <td className="num" title={row.invoice_value.toLocaleString()}>
                        {fmtCurrencyShort(row.invoice_value)}
                      </td>
                      <td className="num strong">
                        {row.normalized_score.toFixed(1)}
                      </td>
                      <td className="num">{fmtPct(row.coverage_pct, 0)}</td>
                      <td className="num">
                        {row.coverage_adjusted_score.toFixed(1)}
                      </td>
                      <td>
                        <span
                          className="sc-band"
                          style={{
                            background: bandStyles[row.band].bg,
                            color: bandStyles[row.band].fg,
                          }}
                        >
                          {row.band}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!filteredScorecards.length && !loading && (
                  <tr>
                    <td colSpan={7} className="sc-empty">
                      No parent suppliers match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Drill-down */}
        <div className="sc-detail">
          {selected && computed ? (
            <>
              <div
                className="sc-detail-header"
                style={{ borderTopColor: bandStyles[computed.band].fg }}
              >
                <div>
                  <p className="eyebrow">Selected Parent Supplier</p>
                  <h2 className="sc-detail-name">{computed.parentSupplier}</h2>
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
              <p>Select a parent supplier from the leaderboard to see the
                pillar-by-pillar breakdown.</p>
            </div>
          )}
        </div>
      </div>

      {/* ─── Framework footer ────────────────────────────────────────────── */}
      <footer className="sc-footer">
        <div>
          <strong>Pillar Weights (Excel Mapping):</strong>{" "}
          {scorecard
            ? Object.entries(scorecard.pillar_weights)
                .map(([p, w]) => `${p} ${w}`)
                .join(" · ")
            : "—"}
        </div>
        <div>
          <strong>Coverage %</strong> = Available KPI Weight / Total Expected KPI
          Weight ({scorecard ? scorecard.total_expected_kpi_weight : 0}).{" "}
          <strong>Coverage-Adjusted</strong> = Normalized × Coverage %.
        </div>
      </footer>
    </section>
  );
}

export default ScorecardPage;
