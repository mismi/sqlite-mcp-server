/**
 * One-command reproduction of the end-to-end coverage job: run the smoke and the evals with
 * NODE_V8_COVERAGE, merge the dumps with c8, then apply the per-file floors.
 *
 * Windows cannot measure the entry point: it terminates child processes unconditionally, so the
 * HTTP child never flushes a dump and the `src/index.ts` floor is skipped with a notice. CI runs
 * this on Linux, where every floor is enforced.
 *
 * Run with: bun run coverage:e2e
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runMain } from "./check-e2e-coverage.js";

const root = join(import.meta.dirname, "..");
const dumps = join(root, ".v8cov");
const report = join(root, "coverage-e2e");
const c8 = join(root, "node_modules", "c8", "bin", "c8.js");
// V8 dumps only come from Node: under Bun the scripts would run without producing any.
const node = process.env.COVERAGE_NODE ?? (process.versions.bun ? "node" : process.execPath);

function step(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(node, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`\n${node} ${args.join(" ")} failed (${result.status ?? result.signal}).`);
    process.exit(result.status ?? 1);
  }
}

rmSync(dumps, { recursive: true, force: true });

const instrumented = { ...process.env, NODE_V8_COVERAGE: dumps };
step(["scripts/smoke.ts"], instrumented);
step(["scripts/evals.ts"], instrumented);

// c8 must not inherit NODE_V8_COVERAGE, or it would write its own dump into the directory it reads.
const clean = { ...process.env };
delete clean.NODE_V8_COVERAGE;
step([c8, "report", "--temp-directory=.v8cov", "--reporter=text", "--reporter=lcov", "--report-dir=coverage-e2e"], clean);

if (process.platform === "win32") {
  console.log(
    "Floors skipped on Windows: child processes are terminated unconditionally, so the report is partial. CI enforces them on Linux."
  );
  process.exit(0);
}

process.exit(runMain([join(report, "lcov.info")]));
