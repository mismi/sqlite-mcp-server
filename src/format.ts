/** Formatting helpers shared by the tools. */
import { CHARACTER_LIMIT } from "./constants.js";
import type { Row } from "./db.js";

/** Converts a SQLite value into something JSON-safe. */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  return value;
}

export function serializeRow(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = serializeValue(value);
  return out;
}

/** Renders a markdown table; newlines and pipes inside cells are escaped. */
export function markdownTable(columns: string[], rows: Record<string, unknown>[]): string {
  const header = `| ${columns.map(escapeCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => escapeCell(formatCell(row[column]))).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return String(serializeValue(value));
}

function escapeCell(text: string): string {
  const flattened = text.replace(/\r?\n/g, " ");
  const shortened = flattened.length > 120 ? `${flattened.slice(0, 117)}...` : flattened;
  // Backslashes are escaped before the pipes: a cell ending in `\` would otherwise turn the
  // separator added below into `\|`, escaping the pipe that ends the column.
  return shortened.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Drops items from the end until the rendered text fits CHARACTER_LIMIT.
 *
 * The caller's render function rebuilds the whole page, pagination fields included, so
 * the text and the structured content always describe the same rows.
 */
export function fitToLimit<T>(items: T[], render: (items: T[]) => string): T[] {
  let kept = items;
  while (kept.length > 1 && render(kept).length > CHARACTER_LIMIT) {
    kept = kept.slice(0, Math.max(1, Math.ceil(kept.length / 2)));
  }
  return kept;
}
