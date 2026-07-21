export type CohortLevel = "Supplier" | "Parent" | "Zone" | "Category";

export type FormulaMode = "softStretch" | "strict";

export type KpiApplicability = "Applicable" | "Not Applicable";

export interface SupplierKpiInputRow {
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  kpiApplicability: KpiApplicability;
  dotPercent: string;
  onTimePoLines: string;
  totalDeliveredPoLines: string;
  x1DelayedOver30Days: string;
  x2EarlyOver30Days: string;
  year: string;
  month: string;
}

export interface KpiConfig {
  maxScore: number;
  criticalFloor: number;
  target: number;
  cohortLevel: CohortLevel;
  formulaMode: FormulaMode;
}

export interface RawDotValues {
  onTimePoLines: number;
  totalDeliveredPoLines: number;
  x1DelayedOver30Days: number;
  x2EarlyOver30Days: number;
}

export interface RowAssessment extends SupplierKpiInputRow {
  rowNumber: number;
  isApplicable: boolean;
  normalizedDot: number | null;
  dotRawInput: string;
  rawAvailable: boolean;
  rawValues: RawDotValues | null;
  isValid: boolean;
  errors: string[];
}

export interface PercentileRank {
  rank: number;
  percentile: number;
  note: "standard" | "single" | "noVariance";
}

export interface ScoredKpiRow extends RowAssessment {
  cohortKey: string;
  rankDescending: number | null;
  percentile: number | null;
  criticalFloor: number;
  target: number;
  attainmentFactor: number | null;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: string;
  explanation: string;
}

export type RollupLevel = "Parent" | "Zone" | "Category";

export interface RollupRow {
  id: string;
  level: RollupLevel;
  isApplicable: boolean;
  label: string;
  parentSupplier: string;
  zone: string;
  country: string;
  dotRawInput: string;
  normalizedDot: number | null;
  rankDescending: number | null;
  percentile: number | null;
  criticalFloor: number;
  target: number;
  attainmentFactor: number | null;
  maxScore: number;
  earnedScore: number | null;
  scorePercent: number | null;
  scoreStatus: string;
  sourceStatus: string;
  explanation: string;
  contributingRows: number;
}
