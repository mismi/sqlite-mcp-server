/**
 * Tests for scripts/check-e2e-coverage.ts, the gate on the Node-only report.
 *
 * Each case writes a small lcov file: the checker only reads text, so reports can be shaped
 * without running the server or c8.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkE2eCoverage, parseRecord, runMain, FLOORS, TARGET } from "./check-e2e-coverage.js";

const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-e2e-coverage-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

type Lines = [number, number][];

/** `count` lines starting at `from`, all covered. */
const hits = (from: number, count: number): Lines =>
  Array.from({ length: count }, (_, index) => [from + index, 1] as [number, number]);

/** `total` lines where only the first `covered` are hit. */
const mixed = (total: number, covered: number): Lines => [
  ...hits(1, covered),
  ...Array.from({ length: total - covered }, (_, index) => [covered + index + 1, 0] as [number, number])
];

/** An lcov report with a decoy first record and then the given files. */
function report(entries: { file: string; lines: Lines }[]): string {
  const records = entries.map(({ file, lines }) =>
    [
      `SF:${file}`,
      ...lines.map(([number, value]) => `DA:${number},${value}`),
      `LF:${lines.length}`,
      `LH:${lines.filter(([, value]) => value > 0).length}`,
      "end_of_record"
    ].join("\n")
  );
  return ["SF:src/constants.ts", "DA:1,1", "LF:1", "LH:1", "end_of_record", ...records].join("\n");
}

function write(name: string, content: string): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

/** The three measured files, each comfortably above its floor. */
const healthy = (): string =>
  report([
    { file: "src/index.ts", lines: hits(1, 62) },
    { file: "src/db.ts", lines: mixed(383, 337) },
    { file: "src/tools/read.ts", lines: mixed(251, 198) }
  ]);

test("a fully covered report passes", () => {
  const result = checkE2eCoverage(write("valid.info", report([{ file: TARGET, lines: hits(1, 62) }])));

  expect(result.failures).toEqual([]);
  expect(result).toMatchObject({ file: TARGET, covered: 62, total: 62, ratio: 1 });
  expect(result.uncovered).toEqual([]);
});

test("the floor is inclusive", () => {
  // 57 of 60 lines is exactly 95 %.
  const result = checkE2eCoverage(write("exact.info", report([{ file: TARGET, lines: mixed(60, 57) }])));

  expect(result.failures).toEqual([]);
});

test("uncovered lines below the floor fail and are listed", () => {
  const result = checkE2eCoverage(write("short.info", report([{ file: TARGET, lines: mixed(62, 50) }])));

  expect(result.ratio).toBeCloseTo(50 / 62, 5);
  expect(result.uncovered).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain("uncovered line(s): 51, 52");
  expect(result.failures[0]).toContain("< 95 %");
});

test("a report without the entry point fails instead of passing silently", () => {
  const result = checkE2eCoverage(write("absent-target.info", report([{ file: "src/server.ts", lines: hits(1, 39) }])));

  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain(`${TARGET} is not in`);
  expect(parseRecord(report([{ file: "src/server.ts", lines: hits(1, 39) }]))).toBeNull();
});

test("a missing report fails with the command that produces it", () => {
  const result = checkE2eCoverage(join(workDir, "does-not-exist.info"));

  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain("No end-to-end report at");
  expect(result.failures[0]).toContain("NODE_V8_COVERAGE");
});

test("line numbers may shift without breaking the floor", () => {
  // reportDatabase moved down: the record starts at 40 instead of 1.
  const result = checkE2eCoverage(write("shifted.info", report([{ file: TARGET, lines: hits(40, 62) }])));

  expect(result.failures).toEqual([]);
  expect(result.ratio).toBe(1);
});

test("an empty record is treated as no coverage", () => {
  const result = checkE2eCoverage(write("empty-record.info", report([{ file: TARGET, lines: [] }])));

  expect(result.ratio).toBe(0);
  expect(result.failures).toHaveLength(1);
});

test("each file is held to its own floor", () => {
  // 78.88 % for read.ts is fine at 75 %, while the same ratio would fail db.ts at 85 %.
  expect(FLOORS).toEqual([
    { file: "src/index.ts", lines: 0.95 },
    { file: "src/db.ts", lines: 0.85 },
    { file: "src/tools/read.ts", lines: 0.75 }
  ]);
  expect(checkE2eCoverage(write("read.info", healthy()), 0.75, "src/tools/read.ts").failures).toEqual([]);

  const dbLow = report([
    { file: "src/index.ts", lines: hits(1, 62) },
    { file: "src/db.ts", lines: mixed(383, 300) },
    { file: "src/tools/read.ts", lines: mixed(251, 198) }
  ]);
  const db = checkE2eCoverage(write("db-low.info", dbLow), 0.85, "src/db.ts");

  expect(db.ratio).toBeCloseTo(300 / 383, 5);
  expect(db.failures).toHaveLength(1);
  expect(db.failures[0]).toContain("< 85 %");
});

test("the CLI exits 0 on a healthy report and 1 when one file lags", () => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    expect(runMain([write("cli-pass.info", healthy())])).toBe(0);

    const dbLow = report([
      { file: "src/index.ts", lines: hits(1, 62) },
      { file: "src/db.ts", lines: mixed(383, 300) },
      { file: "src/tools/read.ts", lines: mixed(251, 198) }
    ]);
    expect(runMain([write("cli-fail.info", dbLow)])).toBe(1);
    expect(runMain([join(workDir, "cli-absent.info")])).toBe(1);
  } finally {
    console.log = log;
    console.error = error;
  }
});
