/**
 * Tests for scripts/check-e2e-coverage.ts, the gate on the Node-only report.
 *
 * Each case writes a small lcov file: the checker only reads text, so the report can be shaped
 * without running the server or c8.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkE2eCoverage, parseRecord, runMain, TARGET } from "./check-e2e-coverage.js";

const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-e2e-coverage-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** An lcov report with a decoy first record, then `lines` as `[number, hits]` pairs. */
function report(lines: [number, number][], entry = TARGET): string {
  return [
    "SF:src/constants.ts",
    "DA:1,1",
    "LF:1",
    "LH:1",
    "end_of_record",
    `SF:${entry}`,
    ...lines.map(([number, hits]) => `DA:${number},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    "end_of_record"
  ].join("\n");
}

function write(name: string, content: string): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

const ALL_HIT = (from: number, count: number): [number, number][] =>
  Array.from({ length: count }, (_, index) => [from + index, 1] as [number, number]);

test("a fully covered report passes", () => {
  const result = checkE2eCoverage(write("valid.info", report(ALL_HIT(1, 62))));

  expect(result.failures).toEqual([]);
  expect(result).toMatchObject({ file: TARGET, covered: 62, total: 62, ratio: 1 });
  expect(result.uncovered).toEqual([]);
});

test("the floor is inclusive", () => {
  // 54 of 60 lines is exactly 90 %.
  const lines: [number, number][] = [...ALL_HIT(1, 54), ...ALL_HIT(55, 6).map(([n]) => [n, 0] as [number, number])];

  expect(checkE2eCoverage(write("exact.info", report(lines))).failures).toEqual([]);
});

test("uncovered lines below the floor fail and are listed", () => {
  const lines: [number, number][] = [...ALL_HIT(1, 50), ...ALL_HIT(51, 12).map(([n]) => [n, 0] as [number, number])];
  const result = checkE2eCoverage(write("short.info", report(lines)));

  expect(result.ratio).toBeCloseTo(50 / 62, 5);
  expect(result.uncovered).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain("uncovered line(s): 51, 52");
  expect(result.failures[0]).toContain("< 90 %");
});

test("a report without the entry point fails instead of passing silently", () => {
  const result = checkE2eCoverage(write("absent-target.info", report([], "src/server.ts")));

  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain(`${TARGET} is not in`);
  expect(parseRecord(report([], "src/server.ts"))).toBeNull();
});

test("a missing report fails with the command that produces it", () => {
  const result = checkE2eCoverage(join(workDir, "does-not-exist.info"));

  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain("No end-to-end report at");
  expect(result.failures[0]).toContain("NODE_V8_COVERAGE");
});

test("line numbers may shift without breaking the floor", () => {
  // reportDatabase moved down: the record starts at 40 instead of 1.
  const result = checkE2eCoverage(write("shifted.info", report(ALL_HIT(40, 62))));

  expect(result.failures).toEqual([]);
  expect(result.ratio).toBe(1);
});

test("an empty record is treated as no coverage", () => {
  const result = checkE2eCoverage(write("empty-record.info", report([])));

  expect(result.ratio).toBe(0);
  expect(result.failures).toHaveLength(1);
});

test("the CLI exits 0 on a passing report and 1 on a failing one", () => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  const halfCovered: [number, number][] = [...ALL_HIT(1, 5), ...ALL_HIT(6, 5).map(([n]) => [n, 0] as [number, number])];
  try {
    expect(runMain([write("cli-pass.info", report(ALL_HIT(1, 62)))])).toBe(0);
    expect(runMain([write("cli-fail.info", report(halfCovered))])).toBe(1);
    expect(runMain([join(workDir, "cli-absent.info")])).toBe(1);
  } finally {
    console.log = log;
    console.error = error;
  }
});
