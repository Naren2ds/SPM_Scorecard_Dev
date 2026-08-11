// ---------------------------------------------------------------------------
// Supplier Maturity Score KPI — Type definitions
// Same shape as Supplier Compliance: pre-computed % per supplier in [0, 1].
// Higher = better.
// ---------------------------------------------------------------------------

export type MaturityCohortLevel =
  | "Supplier"
  | "Parent"
  | "Zone"
  | "Category";

export type MaturityFormulaMode = "strict" | "softStretch";

export type MaturityApplicability = "Applicable" | "Not Applicable";

export type MaturityScoreStatus =
  | "Valid"
  | "Zero Score"
  | "Missing Score"
  | "Not Applicable"
  | "Invalid Data"
  | "Proxy Calculation"
  | "Single Observation"
  | "No Variance";

/** Raw row shape delivered by the backend API. */
export interface SupplierMaturityInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  category: string;
  scorecard_category: string;
  kpiApplicability: MaturityApplicability;
  /** Serialised as string in the API — always in [0, 1] after backend normalisation. */
  maturityScore: string;
  year: string;
}

export interface MaturityConfig {
  maxScore: number;
  criticalFloor: number;
  target: number;
  cohortLevel: MaturityCohortLevel;
  formulaMode: MaturityFormulaMode;
}

export interface MaturityAssessmentRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  category: string;
  scorecard_category: string;
  isApplicable: boolean;
  /** Numeric maturity score in [0, 1] or null if missing/invalid. */
  maturityScore: number | null;
  errors: string[];
}

export interface ScoredMaturityRow extends MaturityAssessmentRow {
  cohortKey: string;
  rankDescending: number | null;
  percentile: number | null;
  criticalFloor: number;
  target: number;
  attainmentFactor: number | null;
  formulaMode: MaturityFormulaMode;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: MaturityScoreStatus;
  explanation: string;
}

export type MaturityRollupLevel = "Parent" | "Zone" | "Category";

export interface RollupMaturityRow extends ScoredMaturityRow {
  level: MaturityRollupLevel;
  label: string;
  contributingSuppliers: number;
  aggregationMethod: "Proxy average";
}

export interface MaturityPercentileRank {
  rank: number;
  percentile: number;
  note: "standard" | "single" | "noVariance";
}
