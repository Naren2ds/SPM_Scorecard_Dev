// ---------------------------------------------------------------------------
// Supplier Compliance % KPI — Type definitions
// Scoring reference: docs/Support_Docs/supplier-compliance-scoring.md
// Backend delivers rows in "direct %" mode: one pre-computed compliancePct
// per supplier (in [0, 1]) — no completed / required document counts.
// ---------------------------------------------------------------------------

export type ComplianceCohortLevel =
  | "Supplier"
  | "Parent"
  | "Zone"
  | "Category"
  | "Country";

export type ComplianceFormulaMode = "strict" | "softStretch";

export type ComplianceApplicability = "Applicable" | "Not Applicable";

export type ComplianceScoreStatus =
  | "Valid"
  | "Zero Score"
  | "Missing Compliance"
  | "Not Applicable"
  | "Invalid Data"
  | "Proxy Calculation"
  | "Single Observation"
  | "No Variance";

/** Raw row shape delivered by the backend API. */
export interface SupplierComplianceInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  kpiApplicability: ComplianceApplicability;
  supplierApprovalStatus: string;
  /** Serialised as string in the API — always in [0, 1] after backend normalisation. */
  compliancePct: string;
  year: string;
}

export interface ComplianceConfig {
  maxScore: number;
  criticalFloor: number;
  target: number;
  cohortLevel: ComplianceCohortLevel;
  formulaMode: ComplianceFormulaMode;
}

export interface ComplianceAssessmentRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  supplierApprovalStatus: string;
  isApplicable: boolean;
  /** Numeric compliance in [0, 1] or null if missing/invalid. */
  compliancePct: number | null;
  errors: string[];
}

export interface ScoredComplianceRow extends ComplianceAssessmentRow {
  cohortKey: string;
  rankDescending: number | null;
  percentile: number | null;
  criticalFloor: number;
  target: number;
  attainmentFactor: number | null;
  formulaMode: ComplianceFormulaMode;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: ComplianceScoreStatus;
  explanation: string;
}

export type ComplianceRollupLevel = "Parent" | "Zone" | "Category" | "Country";

export interface RollupComplianceRow extends ScoredComplianceRow {
  level: ComplianceRollupLevel;
  label: string;
  contributingSuppliers: number;
  /** Rollup Compliance % is always a proxy average because we only have direct %. */
  aggregationMethod: "Proxy average";
}

export interface CompliancePercentileRank {
  rank: number;
  percentile: number;
  note: "standard" | "single" | "noVariance";
}
