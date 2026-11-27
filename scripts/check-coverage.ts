/**
 * Per-file line-coverage floors, read from coverage/lcov.info.
 *
 * `coverageThreshold` in bunfig.toml applies one number to every file, so it is pinned to the
 * weakest module. These floors are stricter where the code is pure or already fully covered,
 * and they name the file when it regresses instead of failing the whole suite anonymously.
 *
 * Run with: bun test --coverage --coverage-reporter=lcov && bun scripts/check-coverage.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LCOV = join(import.meta.dirname, "..", "coverage", "lcov.info");

/** Paths are matched by suffix, so Windows backslashes and Linux slashes both work. */
const FLOORS: { file: string; lines: number }[] = [
  { file: "src/constants.ts", lines: 1 },
  { file: "src/server.ts", lines: 1 },
  { file: "src/tools/write.ts", lines: 1 },
  { file: "src/db.ts", lines: 0.9 },
  { file: "src/format.ts", lines: 0.9 }
];

if (!existsSync(LCOV)) {
  console.error(`No coverage report at ${LCOV}. Run "bun test --coverage --coverage-reporter=lcov" first.`);
  process.exit(1);
}

const coverage = new Map<string, { hit: number; total: number }>();
let record: { file?: string; hit?: number; total?: number } = {};

function flush(): void {
  if (record.file) coverage.set(record.file, { hit: record.hit ?? 0, total: record.total ?? 0 });
  record = {};
}

for (const line of readFileSync(LCOV, "utf8").split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    flush();
    record.file = line.slice(3).trim().replace(/\\/g, "/");
  } else if (line.startsWith("LH:")) {
    record.hit = Number(line.slice(3));
  } else if (line.startsWith("LF:")) {
    record.total = Number(line.slice(3));
  } else if (line === "end_of_record") {
    flush();
  }
}
flush();

const failures: string[] = [];
for (const { file, lines } of FLOORS) {
  const match = [...coverage.entries()].find(([path]) => path === file || path.endsWith(`/${file}`));
  if (!match) {
    failures.push(`${file}: not measured (no lcov record)`);
    continue;
  }
  const [path, { hit, total }] = match;
  const ratio = total === 0 ? 0 : hit / total;
  console.log(`${file.padEnd(22)} ${String(hit).padStart(4)}/${total} = ${(ratio * 100).toFixed(2)} % (floor ${(lines * 100).toFixed(0)} %)`);
  if (ratio < lines) {
    failures.push(`${path}: ${(ratio * 100).toFixed(2)} % < ${(lines * 100).toFixed(0)} %`);
  }
}

if (failures.length > 0) {
  console.error(`\nCoverage floors not met:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log("\nCoverage floors met.");
