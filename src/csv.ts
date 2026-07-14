import type { KpiApplicability, SupplierKpiInputRow } from "./types";

const normalizeHeader = (header: string) =>
  header.toLowerCase().replace(/[^a-z0-9]/g, "");

const parseCsvText = (text: string): string[][] => {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      currentCell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
};

const pick = (
  row: Record<string, string>,
  aliases: string[],
): string => {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value !== undefined) {
      return value;
    }
  }
  return "";
};

const normalizeApplicability = (value: string): KpiApplicability => {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "not applicable" ||
    normalized === "notapplicable" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "no" ||
    normalized === "false"
  ) {
    return "Not Applicable";
  }

  return "Applicable";
};

export function parseSupplierRowsFromCsv(text: string): SupplierKpiInputRow[] {
  const matrix = parseCsvText(text);
  if (matrix.length < 2) {
    return [];
  }

  const headers = matrix[0].map(normalizeHeader);

  return matrix.slice(1).map((cells, index) => {
    const row = headers.reduce<Record<string, string>>((accumulator, header, headerIndex) => {
      accumulator[header] = cells[headerIndex] ?? "";
      return accumulator;
    }, {});

    return {
      id: `upload-${Date.now()}-${index}`,
      supplier: pick(row, ["Supplier"]),
      parentSupplier: pick(row, ["Parent Supplier", "Parent"]),
      zone: pick(row, ["Zone"]),
      country: pick(row, ["Country"]),
      kpiApplicability: normalizeApplicability(
        pick(row, [
          "KPI Applicability",
          "Applicability",
          "Applicable",
          "DOT Applicable",
          "DOT Applicability",
        ]),
      ),
      dotPercent: pick(row, ["DOT %", "DOT", "DOT Percent", "Delivery On Time"]),
      onTimePoLines: pick(row, ["On-Time PO Lines", "On Time PO Lines"]),
      totalDeliveredPoLines: pick(row, ["Total Delivered PO Lines"]),
      x1DelayedOver30Days: pick(row, ["X1 Delayed Over 30 Days", "X1"]),
      x2EarlyOver30Days: pick(row, ["X2 Early Over 30 Days", "X2"]),
    };
  });
}

const escapeCsvCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

export const toCsv = (rows: Array<Array<string | number | null | undefined>>) =>
  rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
