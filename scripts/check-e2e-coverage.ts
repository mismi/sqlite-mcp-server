/**
 * End-to-end line floors for the files the unit suite cannot measure, read from
 * coverage-e2e/lcov.info.
 *
 * The unit suite never loads src/index.ts, and it never drives the SQL error paths or the markdown
 * rendering the smoke and evals reach, so these floors guard the report produced by
 * NODE_V8_COVERAGE + c8 instead. Only Linux gates on it: Windows terminates child processes
 * unconditionally, so the HTTP child never writes a dump there.
 *
 * The startup fallback in reportDatabase carries a `c8 ignore` range, so no line number is
 * hard-coded here: reportDatabase can move without invalidating this check.
 *
 * Run with: ./node_modules/.bin/c8 report --temp-directory=.v8cov --report-dir=coverage-e2e \
 *   --reporter=lcov && bun scripts/check-e2e-coverage.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Floors sit a few lines below what the current smoke and evals reach, so they catch a real loss. */
export const FLOORS: { file: string; lines: number }[] = [
  { file: "src/index.ts", lines: 0.9 },
  { file: "src/db.ts", lines: 0.85 },
  { file: "src/tools/read.ts", lines: 0.75 }
];

export const TARGET = "src/index.ts";
export const FLOOR = FLOORS[0].lines;

export type E2eCheck = {
  file: string;
  covered: number;
  total: number;
  ratio: number;
  uncovered: number[];
  failures: string[];
};

type Record = { covered: number; total: number; uncovered: number[] };

/** Reads the lcov record for `target`, or null when the report does not mention it. */
export function parseRecord(text: string, target = TARGET): Record | null {
  let inTarget = false;
  let found = false;
  let total = 0;
  let covered = 0;
  const uncovered: number[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      inTarget = line.slice(3).trim().replace(/\\/g, "/").endsWith(target);
      if (inTarget) found = true;
    } else if (inTarget && line.startsWith("DA:")) {
      const [number, hits] = line.slice(3).split(",");
      total += 1;
      if (Number(hits) > 0) covered += 1;
      else uncovered.push(Number(number));
    }
  }

  return found ? { covered, total, uncovered } : null;
}

export function checkE2eCoverage(lcovPath: string, floor = FLOOR, target = TARGET): E2eCheck {
  const failures: string[] = [];
  const empty: E2eCheck = { file: target, covered: 0, total: 0, ratio: 0, uncovered: [], failures };

  if (!existsSync(lcovPath)) {
    failures.push(`No end-to-end report at ${lcovPath}. Run the smoke and evals with NODE_V8_COVERAGE, then c8.`);
    return empty;
  }

  const record = parseRecord(readFileSync(lcovPath, "utf8"), target);
  if (!record) {
    failures.push(`${target} is not in ${lcovPath}: it was never loaded under NODE_V8_COVERAGE.`);
    return empty;
  }

  const ratio = record.total === 0 ? 0 : record.covered / record.total;
  if (ratio < floor) {
    failures.push(
      `uncovered line(s): ${record.uncovered.join(", ")} — ${(ratio * 100).toFixed(2)} % < ${(floor * 100).toFixed(0)} %`
    );
  }

  return { file: target, ...record, ratio, failures };
}

/** Prints one line per measured file and returns the exit code, so the CLI path is testable. */
export function runMain(argv: string[] = process.argv.slice(2)): number {
  const path = argv[0] ?? join(import.meta.dirname, "..", "coverage-e2e", "lcov.info");
  const results = FLOORS.map(({ file, lines }) => checkE2eCoverage(path, lines, file));
  const failures = [...new Set(results.flatMap((result) => result.failures))];

  for (const result of results) {
    if (result.total === 0) continue;
    console.log(
      `${result.file.padEnd(22)} ${String(result.covered).padStart(4)}/${result.total} = ` +
        `${(result.ratio * 100).toFixed(2)} % (floor ${(FLOORS.find((entry) => entry.file === result.file)!.lines * 100).toFixed(0)} %)`
    );
  }
  if (failures.length > 0) {
    console.error(`\nEnd-to-end coverage floors not met:\n  ${failures.join("\n  ")}`);
    return 1;
  }

  console.log("\nEnd-to-end coverage floors met.");
  return 0;
}

if (import.meta.main) process.exit(runMain());
