import type {
  CohortLevel,
  FormulaMode,
  KpiConfig,
  PercentileRank,
  RawDotValues,
  RollupLevel,
  RollupRow,
  RowAssessment,
  ScoredKpiRow,
  SupplierKpiInputRow,
} from "./types";

const DOT_OUT_OF_RANGE = "Invalid DOT: value is outside 0-100% range.";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const hasText = (value: string | undefined) => String(value ?? "").trim().length > 0;

const isApplicableValue = (value: string | undefined) =>
  String(value ?? "Applicable").trim().toLowerCase() !== "not applicable";

const parseNumber = (value: string | number | undefined | null): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value).replace(/,/g, "").replace("%", "").trim();
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatRawFormula = (values: RawDotValues) =>
  `${values.onTimePoLines} / (${values.totalDeliveredPoLines} + 0.99 x ${values.x1DelayedOver30Days} + 0.10 x ${values.x2EarlyOver30Days})`;

export function normalizePercent(value: string | number | undefined | null): {
  value: number | null;
  error: string | null;
} {
  const parsed = parseNumber(value);

  if (parsed === null) {
    return { value: null, error: "DOT is required when raw fields are not available." };
  }

  let normalized = parsed;
  if (parsed > 1 && parsed <= 100) {
    normalized = parsed / 100;
  }

  if (normalized < 0 || normalized > 1) {
    return { value: null, error: DOT_OUT_OF_RANGE };
  }

  return { value: normalized, error: null };
}

export function calculateDOTFromRaw(row: SupplierKpiInputRow): {
  rawAvailable: boolean;
  dot: number | null;
  denominator: number | null;
  errors: string[];
  rawInput: string;
  values: RawDotValues | null;
} {
  const rawTouched =
    hasText(row.onTimePoLines) ||
    hasText(row.totalDeliveredPoLines) ||
    hasText(row.x1DelayedOver30Days) ||
    hasText(row.x2EarlyOver30Days);

  if (!rawTouched) {
    return {
      rawAvailable: false,
      dot: null,
      denominator: null,
      errors: [],
      rawInput: "",
      values: null,
    };
  }

  const errors: string[] = [];
  const onTimePoLines = parseNumber(row.onTimePoLines);
  const totalDeliveredPoLines = parseNumber(row.totalDeliveredPoLines);
  const x1DelayedOver30Days = hasText(row.x1DelayedOver30Days)
    ? parseNumber(row.x1DelayedOver30Days)
    : 0;
  const x2EarlyOver30Days = hasText(row.x2EarlyOver30Days)
    ? parseNumber(row.x2EarlyOver30Days)
    : 0;

  if (onTimePoLines === null) {
    errors.push("Raw DOT requires On-Time PO Lines.");
  }
  if (totalDeliveredPoLines === null) {
    errors.push("Raw DOT requires Total Delivered PO Lines.");
  }
  if (x1DelayedOver30Days === null) {
    errors.push("X1 Delayed Over 30 Days must be numeric.");
  }
  if (x2EarlyOver30Days === null) {
    errors.push("X2 Early Over 30 Days must be numeric.");
  }

  const values =
    onTimePoLines !== null &&
    totalDeliveredPoLines !== null &&
    x1DelayedOver30Days !== null &&
    x2EarlyOver30Days !== null
      ? {
          onTimePoLines,
          totalDeliveredPoLines,
          x1DelayedOver30Days,
          x2EarlyOver30Days,
        }
      : null;

  if (values) {
    Object.entries(values).forEach(([label, numericValue]) => {
      if (numericValue < 0) {
        errors.push(`${label} cannot be negative.`);
      }
    });
  }

  if (!values || errors.length > 0) {
    return {
      rawAvailable: true,
      dot: null,
      denominator: null,
      errors,
      rawInput: values ? formatRawFormula(values) : "Raw fields incomplete",
      values,
    };
  }

  const denominator =
    values.totalDeliveredPoLines +
    0.99 * values.x1DelayedOver30Days +
    0.1 * values.x2EarlyOver30Days;

  if (denominator <= 0) {
    errors.push("Raw DOT denominator must be greater than 0.");
  }

  const dot = denominator > 0 ? values.onTimePoLines / denominator : null;
  if (dot !== null && (dot < 0 || dot > 1)) {
    errors.push(DOT_OUT_OF_RANGE);
  }

  return {
    rawAvailable: true,
    dot: errors.length > 0 ? null : dot,
    denominator,
    errors,
    rawInput: formatRawFormula(values),
    values,
  };
}

export function validateConfig(config: KpiConfig): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(config.maxScore) || config.maxScore <= 0) {
    errors.push("Max Score must be greater than 0.");
  }

  if (
    !Number.isFinite(config.criticalFloor) ||
    config.criticalFloor < 0 ||
    config.criticalFloor > 1
  ) {
    errors.push("Critical Floor must be between 0% and 100%.");
  }

  if (!Number.isFinite(config.target) || config.target < 0 || config.target > 1) {
    errors.push("Target must be between 0% and 100%.");
  }

  if (
    Number.isFinite(config.criticalFloor) &&
    Number.isFinite(config.target) &&
    config.criticalFloor >= config.target
  ) {
    errors.push("Critical Floor must be less than Target.");
  }

  return errors;
}

export function validateRows(rows: SupplierKpiInputRow[]): RowAssessment[] {
  return rows.map((row, index) => {
    const isApplicable = isApplicableValue(row.kpiApplicability);

    if (!isApplicable) {
      return {
        ...row,
        rowNumber: index + 1,
        isApplicable,
        normalizedDot: null,
        dotRawInput: "Not applicable",
        rawAvailable: false,
        rawValues: null,
        isValid: false,
        errors: [],
      };
    }

    const rawResult = calculateDOTFromRaw(row);
    const errors = [...rawResult.errors];
    let normalizedDot: number | null = null;
    let dotRawInput = rawResult.rawInput;

    if (rawResult.rawAvailable) {
      normalizedDot = rawResult.dot;
    } else {
      const normalized = normalizePercent(row.dotPercent);
      normalizedDot = normalized.value;
      dotRawInput = row.dotPercent;
      if (normalized.error) {
        errors.push(normalized.error);
      }
    }

    return {
      ...row,
      rowNumber: index + 1,
      isApplicable,
      normalizedDot,
      dotRawInput,
      rawAvailable: rawResult.rawAvailable,
      rawValues: rawResult.values,
      isValid: errors.length === 0 && normalizedDot !== null,
      errors,
    };
  });
}

export function calculatePercentileRanks(
  rows: Array<{ id: string; dot: number }>,
  target: number,
): Map<string, PercentileRank> {
  const result = new Map<string, PercentileRank>();
  const validRows = rows.filter((row) => Number.isFinite(row.dot));
  const count = validRows.length;

  if (count === 0) {
    return result;
  }

  if (count === 1) {
    result.set(validRows[0].id, {
      rank: 1,
      percentile: 1,
      note: "single",
    });
    return result;
  }

  const distinctDots = new Set(validRows.map((row) => row.dot.toFixed(12)));
  if (distinctDots.size === 1) {
    const sharedDot = validRows[0].dot;
    const percentile = sharedDot >= target ? 1 : 0.5;
    const averageRank = (count + 1) / 2;
    validRows.forEach((row) => {
      result.set(row.id, {
        rank: averageRank,
        percentile,
        note: "noVariance",
      });
    });
    return result;
  }

  const sorted = [...validRows].sort((a, b) => b.dot - a.dot);
  let cursor = 0;

  while (cursor < sorted.length) {
    const dotKey = sorted[cursor].dot.toFixed(12);
    let end = cursor + 1;

    while (end < sorted.length && sorted[end].dot.toFixed(12) === dotKey) {
      end += 1;
    }

    const startRank = cursor + 1;
    const endRank = end;
    const averageRank = (startRank + endRank) / 2;
    const percentile = (count - averageRank) / (count - 1);

    for (let index = cursor; index < end; index += 1) {
      result.set(sorted[index].id, {
        rank: averageRank,
        percentile,
        note: "standard",
      });
    }

    cursor = end;
  }

  return result;
}

export function calculateAttainmentFactor(
  dot: number,
  criticalFloor: number,
  target: number,
): number {
  if (dot < criticalFloor) {
    return 0;
  }

  if (dot >= target) {
    return 1;
  }

  return clamp((dot - criticalFloor) / (target - criticalFloor), 0, 1);
}

export function calculateEarnedScore(
  maxScore: number,
  percentile: number,
  attainment: number,
  formulaMode: FormulaMode = "softStretch",
): number {
  if (formulaMode === "softStretch") {
    return maxScore * attainment * (0.7 + 0.3 * percentile);
  }
  return maxScore * percentile * attainment;
}

const dimensionValue = (value: string, fallback: string) => {
  const trimmed = value.trim();
  return trimmed || fallback;
};

const cohortKeyForRow = (row: RowAssessment, cohortLevel: CohortLevel) => {
  if (cohortLevel === "Parent") {
    return dimensionValue(row.parentSupplier, "Unassigned parent");
  }

  if (cohortLevel === "Zone") {
    return dimensionValue(row.zone, "Unassigned zone");
  }

  if (cohortLevel === "Category") {
    return dimensionValue(row.category, "Unassigned category");
  }

  return "All suppliers";
};

const scoreNarrative = (
  dot: number,
  criticalFloor: number,
  target: number,
  rankNote: PercentileRank["note"],
  percentile: number,
  attainmentFactor: number,
  earnedScore: number,
  maxScore: number,
  formulaMode: FormulaMode,
) => {
  const messages: string[] = [];

  const formulaMessage =
    formulaMode === "softStretch"
      ? `Earned Score = ${maxScore.toFixed(2)} \u00d7 ${attainmentFactor.toFixed(4)} \u00d7 (70% + 30% \u00d7 ${(percentile * 100).toFixed(2)}%) = ${earnedScore.toFixed(2)}.`
      : `Earned Score = ${maxScore.toFixed(2)} \u00d7 ${(percentile * 100).toFixed(2)}% \u00d7 ${attainmentFactor.toFixed(4)} = ${earnedScore.toFixed(2)}.`;

  if (rankNote === "single") messages.push("Single observation: percentile set to 100% by rule.");
  if (rankNote === "noVariance") messages.push("No variance: all suppliers have same DOT value.");

  if (dot === 0) {
    messages.push("Zero DOT: supplier is applicable, included in scoring, and earned score is 0.");
    messages.push(formulaMessage);
    return { status: "Zero DOT", explanation: messages.join(" ") };
  }

  if (dot <= criticalFloor || attainmentFactor === 0) {
    messages.push(`Below critical floor: DOT ${(dot * 100).toFixed(2)}% \u2264 floor ${(criticalFloor * 100).toFixed(2)}%. Attainment = 0, earned score = 0.`);
    return { status: "Below critical floor", explanation: messages.join(" ") };
  }

  if (dot >= target) {
    messages.push(`Valid score: DOT ${(dot * 100).toFixed(2)}% is above target ${(target * 100).toFixed(2)}%. Attainment = 1.0000.`);
  } else {
    messages.push(`Valid score: DOT ${(dot * 100).toFixed(2)}% is between floor ${(criticalFloor * 100).toFixed(2)}% and target ${(target * 100).toFixed(2)}%. Attainment = ${attainmentFactor.toFixed(4)}.`);
  }

  if (formulaMode === "softStretch" && attainmentFactor > 0) {
    messages.push("Softer stretch: 70% of attainment score is protected, 30% is differentiated by percentile.");
  }

  messages.push(formulaMessage);

  if (rankNote === "single") return { status: "Single observation", explanation: messages.join(" ") };
  if (rankNote === "noVariance") return { status: "No variance", explanation: messages.join(" ") };
  return { status: "Valid score", explanation: messages.join(" ") };
};

export function scoreSupplierRows(
  rows: SupplierKpiInputRow[],
  config: KpiConfig,
): ScoredKpiRow[] {
  const assessments = validateRows(rows);
  const groupedValidRows = new Map<string, RowAssessment[]>();

  assessments.forEach((row) => {
    if (!row.isApplicable || !row.isValid || row.normalizedDot === null) {
      return;
    }

    const cohortKey = cohortKeyForRow(row, config.cohortLevel);
    const group = groupedValidRows.get(cohortKey) ?? [];
    group.push(row);
    groupedValidRows.set(cohortKey, group);
  });

  const rankLookup = new Map<string, PercentileRank>();
  groupedValidRows.forEach((group) => {
    const ranks = calculatePercentileRanks(
      group.map((row) => ({ id: row.id, dot: row.normalizedDot ?? 0 })),
      config.target,
    );
    ranks.forEach((rank, id) => rankLookup.set(id, rank));
  });

  return assessments.map((row) => {
    const cohortKey = cohortKeyForRow(row, config.cohortLevel);

    if (!row.isApplicable) {
      return {
        ...row,
        cohortKey,
        rankDescending: null,
        percentile: null,
        criticalFloor: config.criticalFloor,
        target: config.target,
        attainmentFactor: null,
        maxScore: config.maxScore,
        earnedScore: null,
        scorePercent: null,
        scoreStatus: "Not applicable",
        explanation:
          "Not applicable: DOT KPI is excluded from ranking, rollups, and earned score for this supplier.",
      };
    }

    if (!row.isValid || row.normalizedDot === null) {
      return {
        ...row,
        cohortKey,
        rankDescending: null,
        percentile: null,
        criticalFloor: config.criticalFloor,
        target: config.target,
        attainmentFactor: null,
        maxScore: config.maxScore,
        earnedScore: null,
        scorePercent: null,
        scoreStatus: "Invalid DOT",
        explanation: row.errors.join(" "),
      };
    }

    const rank = rankLookup.get(row.id);
    const percentile = rank?.percentile ?? null;
    const attainmentFactor = calculateAttainmentFactor(
      row.normalizedDot,
      config.criticalFloor,
      config.target,
    );
    const earnedScore =
      percentile === null
        ? null
        : calculateEarnedScore(config.maxScore, percentile, attainmentFactor, config.formulaMode);
    const narrative = rank && percentile !== null && earnedScore !== null
      ? scoreNarrative(
          row.normalizedDot,
          config.criticalFloor,
          config.target,
          rank.note,
          percentile,
          attainmentFactor,
          earnedScore,
          config.maxScore,
          config.formulaMode,
        )
      : {
          status: "Invalid DOT",
          explanation: "Unable to calculate percentile for this row.",
        };

    return {
      ...row,
      cohortKey,
      rankDescending: rank?.rank ?? null,
      percentile,
      criticalFloor: config.criticalFloor,
      target: config.target,
      attainmentFactor,
      maxScore: config.maxScore,
      earnedScore,
      scorePercent: earnedScore === null ? null : earnedScore / config.maxScore,
      scoreStatus: narrative.status,
      explanation: narrative.explanation,
    };
  });
}

const groupAssessments = (assessments: RowAssessment[], level: RollupLevel) => {
  const groups = new Map<string, RowAssessment[]>();

  assessments.forEach((row) => {
    const key =
      level === "Parent"
        ? dimensionValue(row.parentSupplier, "Unassigned parent")
        : level === "Category"
          ? dimensionValue(row.category, "Unassigned category")
          : dimensionValue(row.zone, "Unassigned zone");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });

  return groups;
};

const summarizeCountries = (rows: RowAssessment[]) => {
  const countries = Array.from(
    new Set(rows.map((row) => row.country.trim()).filter(Boolean)),
  );

  if (countries.length === 0) {
    return "Unassigned";
  }

  if (countries.length === 1) {
    return countries[0];
  }

  return "Multiple";
};

const buildRollupSeeds = (
  rows: SupplierKpiInputRow[],
  level: RollupLevel,
): Array<Omit<RollupRow, "rankDescending" | "percentile" | "attainmentFactor" | "earnedScore" | "scorePercent" | "scoreStatus" | "explanation"> & { errors: string[] }> => {
  const assessments = validateRows(rows);
  const groups = groupAssessments(assessments, level);

  return Array.from(groups.entries()).map(([label, groupRows], index) => {
    const validRows = groupRows.filter(
      (row) => row.isApplicable && row.isValid && row.normalizedDot !== null,
    );
    const notApplicableCount = groupRows.filter((row) => !row.isApplicable).length;
    const invalidCount = groupRows.length - validRows.length - notApplicableCount;
    const allValidRowsHaveRaw =
      validRows.length > 0 && validRows.every((row) => row.rawAvailable && row.rawValues);

    let normalizedDot: number | null = null;
    let dotRawInput = "";
    let sourceStatus = "";
    let isApplicable = true;
    let sumOnTimePoLines: number | null = null;
    let sumTotalDeliveredPoLines: number | null = null;
    let sumX1DelayedOver30Days: number | null = null;
    let sumX2EarlyOver30Days: number | null = null;
    let dotDenominator: number | null = null;
    const errors: string[] = [];

    if (validRows.length === 0 && notApplicableCount === groupRows.length) {
      isApplicable = false;
      sourceStatus = "Not applicable";
      dotRawInput = "Not applicable";
    } else if (validRows.length === 0) {
      errors.push("No valid supplier DOT rows available for this rollup.");
      sourceStatus = "Invalid";
      dotRawInput = "No valid input";
    } else if (allValidRowsHaveRaw) {
      const totals = validRows.reduce<RawDotValues>(
        (accumulator, row) => {
          const rawValues = row.rawValues as RawDotValues;
          return {
            onTimePoLines: accumulator.onTimePoLines + rawValues.onTimePoLines,
            totalDeliveredPoLines:
              accumulator.totalDeliveredPoLines + rawValues.totalDeliveredPoLines,
            x1DelayedOver30Days:
              accumulator.x1DelayedOver30Days + rawValues.x1DelayedOver30Days,
            x2EarlyOver30Days:
              accumulator.x2EarlyOver30Days + rawValues.x2EarlyOver30Days,
          };
        },
        {
          onTimePoLines: 0,
          totalDeliveredPoLines: 0,
          x1DelayedOver30Days: 0,
          x2EarlyOver30Days: 0,
        },
      );

      sumOnTimePoLines = totals.onTimePoLines;
      sumTotalDeliveredPoLines = totals.totalDeliveredPoLines;
      sumX1DelayedOver30Days = totals.x1DelayedOver30Days;
      sumX2EarlyOver30Days = totals.x2EarlyOver30Days;

      const denominator =
        totals.totalDeliveredPoLines +
        0.99 * totals.x1DelayedOver30Days +
        0.1 * totals.x2EarlyOver30Days;
      dotDenominator = denominator;
      normalizedDot = denominator > 0 ? totals.onTimePoLines / denominator : null;
      dotRawInput = formatRawFormula(totals);
      sourceStatus = "Weighted raw aggregation";

      if (denominator <= 0 || normalizedDot === null) {
        errors.push("Raw DOT denominator must be greater than 0.");
      } else if (normalizedDot < 0 || normalizedDot > 1) {
        errors.push(DOT_OUT_OF_RANGE);
      }
    } else {
      normalizedDot =
        validRows.reduce((sum, row) => sum + (row.normalizedDot ?? 0), 0) /
        validRows.length;
      dotRawInput = `Average of ${validRows.length} supplier DOT values`;
      sourceStatus = "Proxy only - simple average; raw numerator/denominator not available.";
    }

    if (invalidCount > 0) {
      sourceStatus = `${sourceStatus} ${invalidCount} invalid supplier row${
        invalidCount === 1 ? "" : "s"
      } excluded.`.trim();
    }

    if (notApplicableCount > 0 && isApplicable) {
      sourceStatus = `${sourceStatus} ${notApplicableCount} not-applicable supplier row${
        notApplicableCount === 1 ? "" : "s"
      } excluded.`.trim();
    }

    return {
      id: `${level.toLowerCase()}-${index}-${label}`,
      level,
      isApplicable,
      label,
      parentSupplier: level === "Parent" ? label : "All parents",
      zone: level === "Zone" ? label : "All zones",
      country: summarizeCountries(groupRows),
      dotRawInput,
      sumOnTimePoLines,
      sumTotalDeliveredPoLines,
      sumX1DelayedOver30Days,
      sumX2EarlyOver30Days,
      dotDenominator,
      normalizedDot: errors.length > 0 ? null : normalizedDot,
      criticalFloor: 0,
      target: 0,
      maxScore: 0,
      sourceStatus,
      contributingRows: validRows.length,
      errors,
    };
  });
};

const scoreRollups = (
  seeds: ReturnType<typeof buildRollupSeeds>,
  config: KpiConfig,
): RollupRow[] => {
  const validSeeds = seeds.filter(
    (seed) => seed.errors.length === 0 && seed.normalizedDot !== null,
  );
  const ranks = calculatePercentileRanks(
    validSeeds.map((seed) => ({
      id: seed.id,
      dot: seed.normalizedDot ?? 0,
    })),
    config.target,
  );

  return seeds.map((seed) => {
    if (!seed.isApplicable) {
      return {
        ...seed,
        rankDescending: null,
        percentile: null,
        criticalFloor: config.criticalFloor,
        target: config.target,
        attainmentFactor: null,
        maxScore: config.maxScore,
        earnedScore: null,
        scorePercent: null,
        scoreStatus: "Not applicable",
        explanation:
          "Not applicable: every supplier in this rollup is excluded from DOT scoring.",
      };
    }

    if (seed.errors.length > 0 || seed.normalizedDot === null) {
      return {
        ...seed,
        rankDescending: null,
        percentile: null,
        criticalFloor: config.criticalFloor,
        target: config.target,
        attainmentFactor: null,
        maxScore: config.maxScore,
        earnedScore: null,
        scorePercent: null,
        scoreStatus: "Invalid DOT",
        explanation: seed.errors.join(" "),
      };
    }

    const rank = ranks.get(seed.id);
    const percentile = rank?.percentile ?? null;
    const attainmentFactor = calculateAttainmentFactor(
      seed.normalizedDot,
      config.criticalFloor,
      config.target,
    );
    const earnedScore =
      percentile === null
        ? null
        : calculateEarnedScore(config.maxScore, percentile, attainmentFactor, config.formulaMode);
    const narrative = rank && percentile !== null && earnedScore !== null
      ? scoreNarrative(
          seed.normalizedDot,
          config.criticalFloor,
          config.target,
          rank.note,
          percentile,
          attainmentFactor,
          earnedScore,
          config.maxScore,
          config.formulaMode,
        )
      : {
          status: "Invalid DOT",
          explanation: "Unable to calculate percentile for this rollup.",
        };
    const sourceMessage = seed.sourceStatus.startsWith("Weighted raw aggregation")
      ? `Rollup DOT uses weighted raw aggregation: sum On-Time PO Lines / (sum Total Delivered PO Lines + 0.99 x sum X1 + 0.10 x sum X2).${seed.sourceStatus
          .replace("Weighted raw aggregation", "")
          .trim()
          ? ` ${seed.sourceStatus.replace("Weighted raw aggregation", "").trim()}`
          : ""}`
      : seed.sourceStatus;

    return {
      ...seed,
      rankDescending: rank?.rank ?? null,
      percentile,
      criticalFloor: config.criticalFloor,
      target: config.target,
      attainmentFactor,
      maxScore: config.maxScore,
      earnedScore,
      scorePercent: earnedScore === null ? null : earnedScore / config.maxScore,
      scoreStatus: narrative.status,
      explanation: `${narrative.explanation} ${sourceMessage}`.trim(),
    };
  });
};

export function calculateParentRollup(
  rows: SupplierKpiInputRow[],
  config: KpiConfig,
): RollupRow[] {
  return scoreRollups(buildRollupSeeds(rows, "Parent"), config);
}

export function calculateZoneRollup(
  rows: SupplierKpiInputRow[],
  config: KpiConfig,
): RollupRow[] {
  return scoreRollups(buildRollupSeeds(rows, "Zone"), config);
}

export function calculateCategoryRollup(
  rows: SupplierKpiInputRow[],
  config: KpiConfig,
): RollupRow[] {
  return scoreRollups(buildRollupSeeds(rows, "Category"), config);
}
