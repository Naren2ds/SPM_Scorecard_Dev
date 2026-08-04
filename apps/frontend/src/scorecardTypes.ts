// ---------------------------------------------------------------------------
// TypeScript types matching the /api/scorecard* response contracts.
// See backend/scorecard.py for the source of truth.
// ---------------------------------------------------------------------------

export type ScorecardKpi = {
  id: string;
  name: string;
  max_score: number;
  raw: number | null;
  attainment: number | null;
  percentile?: number | null;
  earned: number | null;
  applicable: boolean;
  floor_used: number | null;
  target_used: number | null;
};

export type ScorecardPillar = {
  pillar: string;
  weight: number;
  earned_points: number;
  applicable_max_points: number;
  pillar_pct: number | null;
  weighted_contribution: number;
  status: "applicable" | "not_applicable";
  kpis: ScorecardKpi[];
};

export type ParentScorecard = {
  parentSupplier: string;
  normalized_score: number;
  coverage_pct: number;
  coverage_adjusted_score: number;
  applicable_pillar_weight: number;
  total_earned: number;
  total_applicable_max: number;
  invoice_value: number;
  band: "Green" | "Amber" | "Red";
  pillars: ScorecardPillar[];
};

export type ScorecardKpiMeta = {
  id: string;
  name: string;
  pillar: string;
  max_score: number;
  floor: number | null;
  target: number | null;
  direction: string;
  unit: string;
};

export type ScorecardResponse = {
  pillar_weights: Record<string, number>;
  total_expected_kpi_weight: number;
  kpis: ScorecardKpiMeta[];
  scorecards: ParentScorecard[];
  filters_applied: {
    zones: string[];
    categories: string[];
    parents: string[];
  };
};

/** Response of /api/scorecard/parent — single parent detail. */
export type ParentDetailResponse = {
  pillar_weights: Record<string, number>;
  total_expected_kpi_weight: number;
  kpis: ScorecardKpiMeta[];
  scorecard: ParentScorecard | null;
  cached_at?: string | null;
};

export type ScorecardFilterOptions = {
  zones: string[];
  categories: string[];
  parents: string[];
};

export type ScorecardLeaderboardItem = {
  parentSupplier: string;
  normalized_score: number;
  coverage_pct: number;
  coverage_adjusted_score: number;
  invoice_value: number;
  band: ParentScorecard["band"];
  pillar_scores: Record<string, number | null>;
};

export type ScorecardLeaderboardResponse = {
  items: ScorecardLeaderboardItem[];
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  search: string;
  sort: string;
  order: "asc" | "desc";
  cached_at: string | null;
};

export type ScorecardSummary = {
  total_parent_count: number;
  filtered_parent_count: number;
  average_normalized_score: number;
  average_coverage_pct: number;
  band_counts: Record<ParentScorecard["band"], number>;
  cached_at: string | null;
};

export type ScorecardParentSearchItem = {
  parentSupplier: string;
  normalized_score: number;
  band: ParentScorecard["band"];
};

export type ScorecardParentSearchResponse = {
  items: ScorecardParentSearchItem[];
  query: string;
  limit: number;
};

