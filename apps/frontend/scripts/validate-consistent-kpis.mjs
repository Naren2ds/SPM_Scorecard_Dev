import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  KPI_SPECS,
  buildResults,
  calculateQuartiles,
  normalizeSourceRows,
} from "../src/shared/consistentKpiModel.ts";

const DATA_DIR = resolve(process.cwd(), "../backend/data");
const FILES = {
  SA: "supplier_assessment.csv",
  SC: "supplier_compliance.csv",
  SM: "supplier_maturity.csv",
  CO2: "co2_emission.csv",
  ECL: "eclipse.csv",
  IC: "invoice_conformity.csv",
};

for (const [kpiId, filename] of Object.entries(FILES)) {
  const source = parseCsv(readFileSync(resolve(DATA_DIR, filename), "utf8"));
  const rows = normalizeSourceRows(source);
  const hasDefaultYears = rows.some((row) => row.year === "2025" || row.year === "2026");
  const cohort = hasDefaultYears
    ? rows.filter((row) => row.year === "2025" || row.year === "2026")
    : rows;
  const spec = KPI_SPECS[kpiId];
  let config = spec.defaultConfig;
  if (spec.autoQuartiles) {
    const quartiles = calculateQuartiles(cohort, spec);
    assert.ok(quartiles, `${kpiId}: quartiles should be available`);
    config = { ...config, criticalFloor: quartiles.q1, target: quartiles.q3 };
  }

  const parents = buildResults(cohort, spec, config, "parent");
  const suppliers = buildResults(cohort, spec, config, "supplier");
  const expected = independentlyAggregateParents(cohort, kpiId);

  assert.equal(new Set(parents.map((row) => row.label)).size, parents.length, `${kpiId}: duplicate parents`);
  assert.deepEqual(new Set(parents.map((row) => row.label)), new Set(expected.keys()), `${kpiId}: parent population drift`);
  parents.forEach((row) => {
    assert.ok(Math.abs(row.metric - expected.get(row.label)) < 1e-10, `${kpiId}: formula drift for ${row.label}`);
  });

  const selectedParent = parents.find((row) => row.contributingRows > 1)?.label ?? parents[0]?.label;
  assert.ok(selectedParent, `${kpiId}: expected at least one parent`);
  const selectedRows = cohort.filter((row) => parentLabel(row) === selectedParent);
  const selectedSupplierIds = new Set(selectedRows.map((row) => row.id));
  const globalSelectedSuppliers = suppliers.filter((row) => selectedSupplierIds.has(row.id));
  assert.ok(globalSelectedSuppliers.every((row) => parentLabel(row) === selectedParent), `${kpiId}: supplier leakage`);

  const supplierRankById = new Map(suppliers.map((row) => [row.id, row.rank]));
  globalSelectedSuppliers.forEach((row) => {
    assert.equal(row.rank, supplierRankById.get(row.id), `${kpiId}: supplier rank changed after parent selection`);
  });

  for (const level of ["zone", "category"]) {
    const rollups = buildResults(selectedRows, spec, config, level);
    assert.ok(
      rollups.reduce((total, row) => total + row.contributingRows, 0) <= selectedRows.length,
      `${kpiId}: ${level} rollup leaked rows`,
    );
  }

  console.log(`${kpiId}: ${cohort.length} cohort rows, ${parents.length} parents, formula and isolation passed`);
}

function independentlyAggregateParents(rows, kpiId) {
  const groups = new Map();
  for (const row of rows) {
    if (row.kpiApplicability.trim().toLowerCase() === "not applicable") continue;
    const value = rawMetric(row, kpiId);
    if (!value) continue;
    const parent = parentLabel(row);
    const bucket = groups.get(parent) ?? { numerator: 0, denominator: 0, sum: 0, count: 0 };
    if (kpiId === "SA" || kpiId === "IC") {
      bucket.numerator += value.numerator;
      bucket.denominator += value.denominator;
    } else {
      bucket.sum += value.metric;
      bucket.count += 1;
    }
    groups.set(parent, bucket);
  }
  return new Map(Array.from(groups, ([parent, bucket]) => [
    parent,
    kpiId === "SA" || kpiId === "IC"
      ? bucket.numerator / bucket.denominator
      : bucket.sum / bucket.count,
  ]));
}

function rawMetric(row, kpiId) {
  if (kpiId === "SA") {
    const green = number(row.greenCount) ?? 0;
    const yellow = number(row.yellowCount) ?? 0;
    const red = number(row.redCount) ?? 0;
    const valid = green + yellow + red;
    return valid > 0 ? { numerator: green + 0.5 * yellow, denominator: valid } : null;
  }
  if (kpiId === "IC") {
    const total = number(row.totalInvoices);
    if (total === null || total <= 0) return null;
    const mismatches = number(row.mismatchCount) ?? 0;
    return { numerator: Math.max(total - mismatches, 0), denominator: total };
  }
  const field = { SC: "compliancePct", SM: "maturityScore", ECL: "eclipseScore", CO2: "co2Emission" }[kpiId];
  let metric = number(row[field]);
  if (metric === null) return null;
  if (kpiId !== "CO2" && metric > 1 && metric <= 100) metric /= 100;
  return { metric };
}

function parentLabel(row) {
  return row.parentSupplier.trim() || "Unassigned parent";
}

function number(value) {
  if (String(value ?? "").trim() === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) records.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value);
    records.push(row);
  }
  const [headers, ...data] = records;
  return data.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}
