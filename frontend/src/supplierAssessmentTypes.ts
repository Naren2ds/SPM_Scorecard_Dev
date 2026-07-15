// ---------------------------------------------------------------------------
// Supplier Assessment (Quality) KPI — Type definitions
// Scoring reference: docs/Support_Docs/supplier-assessment-percentile-scoring.md
// Data comes pre-aggregated (counts per supplier) from the backend pipeline,
// so the frontend always operates in "summary" mode.
// ---------------------------------------------------------------------------

export type AssessmentCohortLevel =
  | "Supplier"
  | "Parent"
  | "Zone"
  | "Category"
  | "Country";

export type AssessmentFormulaMode = "strict" | "softStretch";

export type AssessmentApplicability = "Applicable" | "Not Applicable";

export type AssessmentScoreStatus =
  | "Valid"
  | "Zero Score"
  | "Missing Assessment"
  | "Not Applicable"
  | "No Valid Assessment"
  | "Single Observation"
  | "No Variance";

/** Raw row shape delivered by the backend API and consumed by the frontend. */
export interface SupplierAssessmentInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  kpiApplicability: AssessmentApplicability;
  supplierApprovalStatus: string;
  greenCount: string;
  yellowCount: string;
  redCount: string;
  naCount: string;
  blankCount: string;
  year: string;
}

export interface AssessmentConfig {
  maxScore: number;
  greenWeight: number;
  yellowWeight: number;
  redWeight: number;
  criticalFloor: number;
  target: number;
  cohortLevel: AssessmentCohortLevel;
  formulaMode: AssessmentFormulaMode;
  redWarningThreshold: number;
  redCapThreshold: number;
  capScoreIfRedExceedsThreshold: boolean;
}

export interface AssessmentCounts {
  greenCount: number;
  yellowCount: number;
  redCount: number;
  naCount: number;
  blankCount: number;
  totalValidAssessments: number;
}

export interface AssessmentCountRow extends AssessmentCounts {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  supplierApprovalStatus: string;
  isApplicable: boolean;
}

export interface ScoredAssessmentRow extends AssessmentCountRow {
  cohortKey: string;
  assessmentHealthIndex: number | null;
  redPercent: number | null;
  rankDescending: number | null;
  percentile: number | null;
  criticalFloor: number;
  target: number;
  attainmentFactor: number | null;
  formulaMode: AssessmentFormulaMode;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: AssessmentScoreStatus;
  explanation: string;
}

export type AssessmentRollupLevel = "Parent" | "Zone" | "Category" | "Country";

export interface RollupAssessmentRow extends ScoredAssessmentRow {
  level: AssessmentRollupLevel;
  label: string;
  contributingSuppliers: number;
}

export interface AssessmentPercentileRank {
  rank: number;
  percentile: number;
  note: "standard" | "single" | "noVariance";
}
