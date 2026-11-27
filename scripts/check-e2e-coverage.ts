/**
 * End-to-end line floor for the built entry point, read from coverage-e2e/lcov.info.
 *
 * The unit suite never loads src/index.ts, so only the smoke and eval runs under
 * NODE_V8_COVERAGE cover it. Its HTTP block counts on Linux alone, where the SIGTERM sent by
 * the smoke is catchable and the child exits through the shutdown handler; the CI step that
 * calls this script is therefore Linux-only.
 *
 * Run with: ./node_modules/.bin/c8 report --temp-directory=.v8cov --report-dir=coverage-e2e \
 *   --reporter=lcov && bun scripts/check-e2e-coverage.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LCOV = process.argv[2] ?? join(import.meta.dirname, "..", "coverage-e2e", "lcov.info");
const TARGET = "src/index.ts";
/** The catch of reportDatabase only fires when no database exists at startup; the smoke seeds one. */
const EXCLUDED = new Set([24, 25, 26, 27]);
const FLOOR = 0.95;

if (!existsSync(LCOV)) {
  console.error(`No end-to-end report at ${LCOV}. Run the smoke and evals with NODE_V8_COVERAGE, then c8.`);
  process.exit(1);
}

const hits = new Map<number, number>();
let inTarget = false;

for (const line of readFileSync(LCOV, "utf8").split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    inTarget = line.slice(3).trim().replace(/\\/g, "/").endsWith(TARGET);
  } else if (inTarget && line.startsWith("DA:")) {
    const [number, count] = line.slice(3).split(",");
    hits.set(Number(number), Number(count));
  }
}

if (hits.size === 0) {
  console.error(`${TARGET} is not in ${LCOV}: the built server was never loaded under NODE_V8_COVERAGE.`);
  process.exit(1);
}

const failures: string[] = [];
for (const line of EXCLUDED) {
  if (!hits.has(line)) failures.push(`line ${line} is no longer in ${TARGET}; update the exclusion list`);
}

const counted = [...hits.entries()].filter(([line]) => !EXCLUDED.has(line));
const uncovered = counted.filter(([, count]) => count === 0).map(([line]) => line);
const ratio = counted.length === 0 ? 0 : (counted.length - uncovered.length) / counted.length;

console.log(
  `${TARGET.padEnd(22)} ${String(counted.length - uncovered.length).padStart(4)}/${counted.length} = ` +
    `${(ratio * 100).toFixed(2)} % (floor ${(FLOOR * 100).toFixed(0)} %, ${EXCLUDED.size} startup-error lines ignored)`
);

if (ratio < FLOOR) {
  failures.push(`uncovered line(s): ${uncovered.join(", ")} — ${(ratio * 100).toFixed(2)} % < ${(FLOOR * 100).toFixed(0)} %`);
}

if (failures.length > 0) {
  console.error(`\nEnd-to-end coverage floor not met:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log("\nEnd-to-end coverage floor met.");
