import { useMemo, useRef, useState } from "react";
import {
  calculateParentRollup,
  calculateZoneRollup,
  scoreSupplierRows,
  validateConfig,
  validateRows,
} from "./scoring";
import { parseSupplierRowsFromCsv, toCsv } from "./csv";
import type {
  CohortLevel,
  KpiConfig,
  RollupRow,
  ScoredKpiRow,
  SupplierKpiInputRow,
} from "./types";

const emptyRow = (id: string): SupplierKpiInputRow => ({
  id,
  supplier: "",
  parentSupplier: "",
  zone: "",
  country: "",
  kpiApplicability: "Applicable",
  dotPercent: "",
  onTimePoLines: "",
  totalDeliveredPoLines: "",
  x1DelayedOver30Days: "",
  x2EarlyOver30Days: "",
});

const dotFields: Array<{
  key: keyof SupplierKpiInputRow;
  label: string;
  width: string;
  type?: string;
  options?: Array<SupplierKpiInputRow[keyof SupplierKpiInputRow]>;
}> = [
  { key: "supplier", label: "Supplier", width: "150px" },
  { key: "parentSupplier", label: "Parent Supplier", width: "165px" },
  { key: "zone", label: "Zone", width: "110px" },
  { key: "country", label: "Country", width: "110px" },
  {
    key: "kpiApplicability",
    label: "KPI Applicability",
    width: "155px",
    options: ["Applicable", "Not Applicable"],
  },
  { key: "dotPercent", label: "DOT % Override", width: "135px" },
  { key: "onTimePoLines", label: "On-Time PO Lines", width: "130px", type: "number" },
  {
    key: "totalDeliveredPoLines",
    label: "Total Delivered PO Lines",
    width: "160px",
    type: "number",
  },
  {
    key: "x1DelayedOver30Days",
    label: "X1 Delayed Over 30 Days",
    width: "165px",
    type: "number",
  },
  {
    key: "x2EarlyOver30Days",
    label: "X2 Early Over 30 Days",
    width: "160px",
    type: "number",
  },
];

const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(digits)}%`;

const numeric = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);

const formatRank = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "-"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(1);

const displayText = (value: string, fallback: string) => value.trim() || fallback;

const CATEGORIES = [
  "All",
  "LOGISTICS",
  "PACKAGING",
  "FOLDING CARTONS",
  "SERVICES",
  "RAU",
  "INDIRECTS",
];

const MONTHS = [
  "All",
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const currentYear = new Date().getFullYear();
const YEARS = ["All", ...Array.from({ length: 5 }, (_, i) => String(currentYear - 2 + i))];

function DotKpiPage() {
  const [rows, setRows] = useState<SupplierKpiInputRow[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [config, setConfig] = useState<KpiConfig>({
    maxScore: 15,
    criticalFloor: 0.7,
    target: 0.85,
    cohortLevel: "Supplier",
    formulaMode: "softStretch",
  });
  const [category, setCategory] = useState("All");
  const [year, setYear] = useState("All");
  const [month, setMonth] = useState("All");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const configErrors = useMemo(() => validateConfig(config), [config]);
  const configIsValid = configErrors.length === 0;
  const inputAssessments = useMemo(() => validateRows(rows), [rows]);
  const inputAssessmentById = useMemo(
    () => new Map(inputAssessments.map((assessment) => [assessment.id, assessment])),
    [inputAssessments],
  );

  const supplierScores = useMemo(
    () => (configIsValid ? scoreSupplierRows(rows, config) : []),
    [rows, config, configIsValid],
  );

  const zoneRollup = useMemo(
    () => (configIsValid ? calculateZoneRollup(rows, config) : []),
    [rows, config, configIsValid],
  );

  const parentRollup = useMemo(
    () => (configIsValid ? calculateParentRollup(rows, config) : []),
    [rows, config, configIsValid],
  );

  const updateRow = (
    id: string,
    field: keyof SupplierKpiInputRow,
    value: SupplierKpiInputRow[keyof SupplierKpiInputRow],
  ) => {
    setRows((currentRows) =>
      currentRows.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  };

  const updateNumericConfig = (
    field: "maxScore" | "criticalFloor" | "target",
    value: string,
    scale = 1,
  ) => {
    setConfig((currentConfig) => ({
      ...currentConfig,
      [field]: value === "" ? Number.NaN : Number(value) / scale,
    }));
  };

  const addRow = () => {
    setRows((currentRows) => [...currentRows, emptyRow(`manual-${Date.now()}`)]);
  };

  const removeRow = (id: string) => {
    setRows((currentRows) => currentRows.filter((row) => row.id !== id));
  };

  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    const parsedRows = parseSupplierRowsFromCsv(text);

    if (parsedRows.length === 0) {
      setUploadMessage("No supplier DOT rows were found in the CSV.");
      return;
    }

    setRows(parsedRows);
    setUploadMessage(`${parsedRows.length} supplier DOT rows loaded from ${file.name}.`);
    event.target.value = "";
  };

  const exportResults = () => {
    const csv = toCsv([
      ["DOT Config Values Used"],
      ["Max Score", config.maxScore],
      ["Critical Floor %", percent(config.criticalFloor, 2)],
      ["Target %", percent(config.target, 2)],
      ["Category", category],
      ["Year", year],
      ["Month", month],
      ["Formula Mode", config.formulaMode === "softStretch" ? "Softer Percentile Stretch" : "Strict Percentile x Attainment"],
      [],
      ["Supplier Level Results"],
      [
        "Supplier",
        "Parent Supplier",
        "Zone",
        "Country",
        "KPI Applicability",
        "DOT Normalized %",
        "Rank Descending",
        "Scoring Percentile %",
        "Attainment Factor",
        "Max Score",
        "Earned Score",
        "Score %",
        "Critical Floor %",
        "Target %",
        "Score Status",
        "Explanation",
      ],
      ...supplierScores.map((row) => [
        displayText(row.supplier, `Row ${row.rowNumber}`),
        displayText(row.parentSupplier, "Unassigned"),
        displayText(row.zone, "Unassigned"),
        displayText(row.country, "Unassigned"),
        row.kpiApplicability,
        percent(row.normalizedDot, 2),
        formatRank(row.rankDescending),
        percent(row.percentile, 2),
        numeric(row.attainmentFactor, 4),
        numeric(row.maxScore, 2),
        numeric(row.earnedScore, 2),
        percent(row.scorePercent, 2),
        percent(row.criticalFloor, 2),
        percent(row.target, 2),
        row.scoreStatus,
        row.explanation,
      ]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "dot-kpi-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="top-bar kpi-page-heading">
        <div>
          <p className="eyebrow">Delivery KPI</p>
          <h1>DOT Percentile Scoring</h1>
          <p className="kpi-value-note">
            Value = On-Time PO Lines / (Total Delivered PO Lines + 0.99 &times; X1&nbsp;Delayed&nbsp;&gt;30d + 0.10 &times; X2&nbsp;Early&nbsp;&gt;30d)
          </p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={exportResults} disabled={!configIsValid || rows.length === 0}>
            Export Results
          </button>
        </div>
      </section>

      {/* Horizontal Configuration Bar */}
      <section className="config-bar">
        <label>
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Year</span>
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            {YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Month</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {MONTHS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Max Score</span>
          <input
            type="number"
            min="0"
            step="0.5"
            value={Number.isFinite(config.maxScore) ? config.maxScore : ""}
            onChange={(event) => updateNumericConfig("maxScore", event.target.value)}
          />
        </label>
        <label>
          <span>Critical Floor %</span>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={
              Number.isFinite(config.criticalFloor)
                ? Number((config.criticalFloor * 100).toFixed(4))
                : ""
            }
            onChange={(event) =>
              updateNumericConfig("criticalFloor", event.target.value, 100)
            }
          />
        </label>
        <label>
          <span>Target %</span>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={
              Number.isFinite(config.target)
                ? Number((config.target * 100).toFixed(4))
                : ""
            }
            onChange={(event) => updateNumericConfig("target", event.target.value, 100)}
          />
        </label>
        <label>
          <span>Cohort Level</span>
          <select
            value={config.cohortLevel}
            onChange={(event) =>
              setConfig((currentConfig) => ({
                ...currentConfig,
                cohortLevel: event.target.value as CohortLevel,
              }))
            }
          >
            <option value="Supplier">Supplier</option>
            <option value="Parent">Parent</option>
            <option value="Zone">Zone</option>
          </select>
        </label>
        <label>
          <span>Formula Mode</span>
          <select
            value={config.formulaMode}
            onChange={(event) =>
              setConfig((currentConfig) => ({
                ...currentConfig,
                formulaMode: event.target.value as "softStretch" | "strict",
              }))
            }
          >
            <option value="softStretch">Softer Percentile Stretch</option>
            <option value="strict">Strict Percentile &times; Attainment</option>
          </select>
        </label>

        {configErrors.length > 0 && (
          <div className="validation-box config-bar-errors">
            {configErrors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        )}
      </section>

      {/* Data Input */}
      <section className="input-panel">
        <div className="panel-heading">
          <div>
            <h2>Data Input</h2>
            <p className="supporting">
              DOT is calculated from raw PO-line values when available. DOT % Override is only a fallback.
            </p>
            {uploadMessage && <p className="supporting">{uploadMessage}</p>}
          </div>
          <div className="table-actions">
            <button type="button" onClick={addRow}>
              Add Row
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              Upload CSV
            </button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvUpload}
            />
          </div>
        </div>

        <div className="table-frame input-table-frame">
          <table className="data-table input-table">
            <thead>
              <tr>
                {dotFields.map((field) => (
                  <th key={field.key} style={{ minWidth: field.width }}>
                    {field.label}
                  </th>
                ))}
                <th className="calculated-dot-column">Calculated DOT %</th>
                <th className="row-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={dotFields.length + 2} className="empty-state-cell">
                    No data loaded. Upload a CSV or add rows manually.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    {dotFields.map((field) => (
                      <td key={field.key}>
                        {field.options ? (
                          <select
                            value={row[field.key]}
                            onChange={(event) =>
                              updateRow(
                                row.id,
                                field.key,
                                event.target.value as SupplierKpiInputRow[keyof SupplierKpiInputRow],
                              )
                            }
                          >
                            {field.options.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={field.type ?? "text"}
                            value={row[field.key]}
                            onChange={(event) =>
                              updateRow(row.id, field.key, event.target.value)
                            }
                          />
                        )}
                      </td>
                    ))}
                    <td className="calculated-dot-cell">
                      {inputAssessmentById.get(row.id)?.isApplicable === false
                        ? "N/A"
                        : inputAssessmentById.get(row.id)?.isValid === false
                          ? "Invalid"
                          : percent(
                              inputAssessmentById.get(row.id)?.normalizedDot ?? null,
                              2,
                            )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => removeRow(row.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Results */}
      <section className="results-panel">
        <h2>Calculation Results</h2>
        {rows.length === 0 ? (
          <div className="empty-state">Load data to see scoring results.</div>
        ) : !configIsValid ? (
          <div className="empty-state">Fix the configuration to calculate scores.</div>
        ) : (
          <div className="calculation-stack">
            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">1</span>
                <h3>Supplier Level Calculation</h3>
              </summary>
              <SupplierResults rows={supplierScores} />
            </details>

            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">2</span>
                <h3>Zone Level Rollup</h3>
              </summary>
              <RollupResults rows={zoneRollup} label="Zone" />
            </details>

            <details className="calculation-section" open>
              <summary className="calculation-heading level-summary">
                <span className="level-badge">3</span>
                <h3>Parent Level Rollup</h3>
              </summary>
              <RollupResults rows={parentRollup} label="Parent Supplier" />
            </details>
          </div>
        )}
      </section>
    </>
  );
}

function SupplierResults({ rows }: { rows: ScoredKpiRow[] }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Parent Supplier</th>
            <th>Zone</th>
            <th>Country</th>
            <th>KPI Applicability</th>
            <th>DOT Normalized %</th>
            <th>Rank Descending</th>
            <th>Scoring Percentile %</th>
            <th>Attainment Factor</th>
            <th>Max Score</th>
            <th>Earned Score</th>
            <th>Score %</th>
            <th>Critical Floor %</th>
            <th>Target %</th>
            <th>Score Status</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{displayText(row.supplier, `Row ${row.rowNumber}`)}</td>
              <td>{displayText(row.parentSupplier, "Unassigned")}</td>
              <td>{displayText(row.zone, "Unassigned")}</td>
              <td>{displayText(row.country, "Unassigned")}</td>
              <td>{row.kpiApplicability}</td>
              <td>{percent(row.normalizedDot, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td>{percent(row.criticalFloor, 2)}</td>
              <td>{percent(row.target, 2)}</td>
              <td>
                <span className={`status-pill ${statusClass(row.scoreStatus)}`}>
                  {row.scoreStatus}
                </span>
              </td>
              <td className="explanation-cell">{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RollupResults({ rows, label }: { rows: RollupRow[]; label: string }) {
  return (
    <div className="table-frame">
      <table className="data-table results-table">
        <thead>
          <tr>
            <th>{label}</th>
            <th>Parent Supplier</th>
            <th>Zone</th>
            <th>Country</th>
            <th>DOT Normalized %</th>
            <th>Rank Descending</th>
            <th>Scoring Percentile %</th>
            <th>Attainment Factor</th>
            <th>Max Score</th>
            <th>Earned Score</th>
            <th>Score %</th>
            <th>Critical Floor %</th>
            <th>Target %</th>
            <th>Score Status</th>
            <th>Source Status</th>
            <th>Contributing Rows</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={rowClass(row.scoreStatus)}>
              <td>{row.label}</td>
              <td>{row.parentSupplier}</td>
              <td>{row.zone}</td>
              <td>{row.country}</td>
              <td>{percent(row.normalizedDot, 2)}</td>
              <td>{formatRank(row.rankDescending)}</td>
              <td>{percent(row.percentile, 2)}</td>
              <td>{numeric(row.attainmentFactor, 4)}</td>
              <td>{numeric(row.maxScore, 2)}</td>
              <td>{numeric(row.earnedScore, 2)}</td>
              <td>{percent(row.scorePercent, 2)}</td>
              <td>{percent(row.criticalFloor, 2)}</td>
              <td>{percent(row.target, 2)}</td>
              <td>
                <span className={`status-pill ${statusClass(row.scoreStatus)}`}>
                  {row.scoreStatus}
                </span>
              </td>
              <td>{row.sourceStatus}</td>
              <td>{row.contributingRows}</td>
              <td className="explanation-cell">{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const rowClass = (status: string) => {
  if (status === "Invalid DOT") return "invalid-row";
  if (status === "Not applicable") return "not-applicable-row";
  return "";
};

const statusClass = (status: string) => {
  if (status === "Invalid DOT") return "status-invalid";
  if (status === "Not applicable") return "status-na";
  if (status === "Below critical floor" || status === "Zero DOT") return "status-floor";
  if (status === "No variance" || status === "Single observation") return "status-note";
  return "status-valid";
};

export default DotKpiPage;
