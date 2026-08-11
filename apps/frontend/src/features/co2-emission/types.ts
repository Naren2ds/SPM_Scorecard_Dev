// ---------------------------------------------------------------------------
// CO2 Emission KPI — Type definitions
// Backend delivers rows in "direct value" mode: one pre-computed co2Emission
// per supplier (absolute tonnes CO2e, interpreted as CO2 Reduction Potential
// where HIGHER is BETTER).
// ---------------------------------------------------------------------------

export type Co2CohortLevel =
  | "Supplier"
  | "Parent"
  | "Zone";

export type Co2FormulaMode = "strict" | "softStretch";

export type Co2Applicability = "Applicable" | "Not Applicable";

export type Co2ScoreStatus =
  | "Valid"
  | "Zero Score"
  | "Missing Value"
  | "Not Applicable"
  | "Invalid Data"
  | "Proxy Calculation"
  | "Single Observation"
  | "No Variance";

/** Raw row shape delivered by the backend API. */
export interface Co2EmissionInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  category: string;
  scorecard_category: string;
  kpiApplicability: Co2Applicability;
  /** Serialised as string in the API — absolute tonnes CO2e. */
  co2Emission: string;
  year: string;
}

export interface Co2Config {
  maxScore: number;
  /** Critical Floor in absolute tonnes (default = Q1 of filtered rows). */
  criticalFloor: number;
  /** Target in absolute tonnes (default = Q3 of filtered rows). */
  target: number;
  cohortLevel: Co2CohortLevel;
  formulaMode: Co2FormulaMode;
}

export interface Co2AssessmentRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  category: string;
  scorecard_category: string;
  isApplicable: boolean;
  /** Numeric CO2 emission (tonnes) or null if missing/invalid. */
  co2Emission: number | null;
  errors: string[];
}

export interface ScoredCo2Row extends Co2AssessmentRow {
  cohortKey: string;
  rankDescending: number | null;
  percentile: number | null;
  criticalFloor: number;
  target: number;
  attainmentFactor: number | null;
  formulaMode: Co2FormulaMode;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: Co2ScoreStatus;
  explanation: string;
}

export type Co2RollupLevel = "Parent" | "Zone";

export interface RollupCo2Row extends ScoredCo2Row {
  level: Co2RollupLevel;
  label: string;
  contributingSuppliers: number;
  aggregationMethod: "Proxy average";
}

export interface Co2PercentileRank {
  rank: number;
  percentile: number;
  note: "standard" | "single" | "noVariance";
}
