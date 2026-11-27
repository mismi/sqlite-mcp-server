/**
 * One-command reproduction of the end-to-end coverage job: run the smoke and the evals with
 * NODE_V8_COVERAGE, merge the dumps with c8, then check the entry point's line floor with c8's
 * own check-coverage.
 *
 * Windows cannot measure the entry point: it terminates child processes unconditionally, so the
 * HTTP child never flushes a dump and the check is skipped with a notice. CI runs this on Linux.
 *
 * Run with: bun run coverage:e2e
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

/** The parts of a finished child process this script cares about. */
export interface StepOutcome {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
}

/** Runs one command; injected by the tests so no smoke, eval or c8 process is started. */
export type Runner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => StepOutcome;

export interface Options {
  /** Repository root, where the dumps, the c8 binary and the scripts are resolved. */
  root: string;
  /** Node executable; defaults to COVERAGE_NODE, then to `node` under Bun, then to this process. */
  node?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  log?: (line: string) => void;
  reportError?: (line: string) => void;
}

export interface Floor {
  /** Built file c8 matches before remapping. */
  include: string;
  /** Percentage of lines that must be covered; c8 thresholds are not fractions. */
  lines: number;
}

/** End-to-end floors: the entry point, then the module whose startup paths it drives. */
export const FLOORS: Floor[] = [
  { include: "dist/index.js", lines: 90 },
  // Measured at 89.03 % (341/383). 87 % keeps about seven lines of slack; 88 % would keep four.
  { include: "dist/db.js", lines: 87 }
];

export const spawnStep: Runner = (command, args, options) =>
  spawnSync(command, args, { ...options, stdio: "inherit" }) as unknown as StepOutcome;

/**
 * Runs the whole job and returns the process exit code, so the tests can exercise every branch
 * without spawning anything.
 */
export function coverageE2e(options: Options): number {
  const { root } = options;
  // V8 dumps only come from Node: under Bun the scripts would run without producing any.
  const node = options.node ?? process.env.COVERAGE_NODE ?? (process.versions.bun ? "node" : process.execPath);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? spawnStep;
  const log = options.log ?? console.log;
  const reportError = options.reportError ?? console.error;

  const dumps = join(root, ".v8cov");
  const c8 = join(root, "node_modules", "c8", "bin", "c8.js");

  // A dump left by an earlier run would be merged into this one.
  rmSync(dumps, { recursive: true, force: true });

  const step = (args: string[], stepEnv: NodeJS.ProcessEnv): boolean => {
    const result = run(node, args, { cwd: root, env: stepEnv });
    if (result.error) {
      reportError(
        result.error.code === "ENOENT"
          ? `Cannot find Node (\`${node}\`): install Node 22.18 or later, put it on PATH, or set COVERAGE_NODE to its path.`
          : `\`${node} ${args.join(" ")}\` could not start: ${result.error.message}`
      );
      return false;
    }
    if (result.status !== 0) {
      reportError(`\`${node} ${args.join(" ")}\` failed (${result.status ?? result.signal}).`);
      return false;
    }
    return true;
  };

  const instrumented = { ...env, NODE_V8_COVERAGE: dumps };
  if (!step(["scripts/smoke.ts"], instrumented)) return 1;
  if (!step(["scripts/evals.ts"], instrumented)) return 1;

  // c8 must not inherit NODE_V8_COVERAGE, or it would write its own dump into the directory it reads.
  const clean = { ...env };
  delete clean.NODE_V8_COVERAGE;
  if (
    !step(
      [c8, "report", "--temp-directory=.v8cov", "--reporter=text", "--reporter=lcov", "--report-dir=coverage-e2e"],
      clean
    )
  ) {
    return 1;
  }

  if (platform === "win32") {
    log(
      "Floor skipped on Windows: child processes are terminated unconditionally, so the report is partial. CI enforces it on Linux."
    );
    return 0;
  }

  // c8's own gates, one per file so each keeps its own threshold. `--include` is matched against
  // the raw script paths, before the source map is applied, so it names the built files; the report
  // still attributes the lines to src/. Thresholds are percentages, hence 90 rather than 0.9.
  for (const floor of FLOORS) {
    const gate = [
      c8,
      "check-coverage",
      "--temp-directory=.v8cov",
      `--include=${floor.include}`,
      `--lines=${floor.lines}`
    ];
    if (!step(gate, clean)) return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(coverageE2e({ root: join(import.meta.dirname, "..") }));
}
