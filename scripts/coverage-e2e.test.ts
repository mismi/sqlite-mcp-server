import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverageE2e, spawnStep, type Runner, type StepOutcome } from "./coverage-e2e.ts";

interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-e2e-"));
  roots.push(root);
  return root;
}

/** Records every command, answers with `outcome` (0 by default), and never spawns anything. */
function harness(outcome: (args: string[]) => StepOutcome = () => ({ status: 0 })) {
  const calls: Call[] = [];
  const run: Runner = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return outcome(args);
  };
  return { calls, run };
}

function collect() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), reportError: (line: string) => lines.push(line) };
}

describe("coverageE2e", () => {
  test("skips the floor on Windows after writing the report", () => {
    const root = workspace();
    const { calls, run } = harness();
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "win32", run, ...output });

    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toEqual(["scripts/smoke.ts"]);
    expect(calls[2]?.args[0]).toBe(join(root, "node_modules", "c8", "bin", "c8.js"));
    expect(calls[1]?.args).toEqual(["scripts/evals.ts"]);
    expect(calls[2]?.args).toContain("report");
    expect(calls.some((call) => call.args.includes("check-coverage"))).toBe(false);
    expect(output.lines.join("\n")).toContain("Floor skipped on Windows");
    expect(output.lines.join("\n")).not.toContain("failed");
  });

  test("enforces the floor on Linux", () => {
    const root = workspace();
    const { calls, run } = harness();
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(0);
    expect(calls).toHaveLength(6);
    const [entryGate, dbGate, readGate] = [calls[3]!.args, calls[4]!.args, calls[5]!.args];
    expect(entryGate).toContain("check-coverage");
    expect(entryGate).toContain("--include=dist/index.js");
    expect(entryGate).toContain("--lines=90");
    expect(entryGate).toContain("--branches=75");
    expect(dbGate).toContain("check-coverage");
    expect(dbGate).toContain("--include=dist/db.js");
    expect(dbGate).toContain("--lines=90");
    expect(dbGate).toContain("--branches=80");
    expect(readGate).toContain("check-coverage");
    expect(readGate).toContain("--include=dist/tools/read.js");
    expect(readGate).toContain("--lines=95");
    expect(readGate).toContain("--branches=95");
    expect(output.lines).toEqual([]);
  });

  test("returns 1 when the entry point floor is missed", () => {
    const root = workspace();
    const { calls, run } = harness((args) => ({ status: args.includes("check-coverage") ? 1 : 0 }));
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    expect(calls).toHaveLength(4);
    const message = output.lines.join("\n");
    expect(message).toContain("check-coverage");
    expect(message).toContain("failed (1)");
  });

  test("returns 1 when only the read.ts floor is missed", () => {
    const root = workspace();
    const { calls, run } = harness((args) => ({ status: args.includes("--include=dist/tools/read.js") ? 1 : 0 }));
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    expect(calls).toHaveLength(6);
    expect(output.lines.join("\n")).toContain("--include=dist/tools/read.js");
  });

  test("asks c8 for branches on every gate, not only lines", () => {
    const root = workspace();
    const { calls, run } = harness();
    const output = collect();

    coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    const gates = calls.filter((call) => call.args.includes("check-coverage"));
    expect(gates).toHaveLength(3);
    for (const gate of gates) {
      expect(gate.args.some((arg) => arg.startsWith("--lines="))).toBe(true);
      expect(gate.args.some((arg) => arg.startsWith("--branches="))).toBe(true);
    }
  });

  test("returns 1 when only the db.ts floor is missed", () => {
    const root = workspace();
    const { calls, run } = harness((args) => ({ status: args.includes("--include=dist/db.js") ? 1 : 0 }));
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    expect(calls).toHaveLength(5);
    expect(output.lines.join("\n")).toContain("--include=dist/db.js");
  });

  test("stops once the smoke fails", () => {
    const root = workspace();
    const { calls, run } = harness(() => ({ status: 2 }));
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(output.lines.join("\n")).toContain("failed (2)");
  });

  test("explains a missing Node instead of reporting a status", () => {
    const root = workspace();
    const missing = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    const { calls, run } = harness(() => ({ status: null, error: missing }));
    const output = collect();

    const code = coverageE2e({ root, node: "/opt/node/bin/node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/opt/node/bin/node");
    const message = output.lines.join("\n");
    expect(message).toContain("Cannot find Node");
    expect(message).toContain("/opt/node/bin/node");
    expect(message).toContain("COVERAGE_NODE");
  });

  test("forwards NODE_V8_COVERAGE to the instrumented runs only", () => {
    const root = workspace();
    const { calls, run } = harness();
    const output = collect();

    coverageE2e({
      root,
      node: "node",
      platform: "linux",
      env: { PATH: "/usr/bin", NODE_V8_COVERAGE: "/somewhere/else" },
      run,
      ...output
    });

    const dumps = join(root, ".v8cov");
    expect(calls[0]?.env.NODE_V8_COVERAGE).toBe(dumps);
    expect(calls[1]?.env.NODE_V8_COVERAGE).toBe(dumps);
    for (const call of calls.slice(2)) {
      expect(call.env.NODE_V8_COVERAGE).toBeUndefined();
    }
    expect(calls[2]?.env.PATH).toBe("/usr/bin");
  });

  test("returns 1 when the report fails, before reaching the floor", () => {
    const root = workspace();
    const { calls, run } = harness((args) => ({ status: args.includes("report") ? 3 : 0 }));
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.args.includes("check-coverage"))).toBe(false);
    expect(output.lines.join("\n")).toContain("failed (3)");
  });

  test("reports a runner that cannot start for another reason", () => {
    const root = workspace();
    const denied = Object.assign(new Error("spawn node EACCES"), { code: "EACCES" });
    const { run } = harness(() => ({ status: null, error: denied }));
    const output = collect();

    const code = coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(code).toBe(1);
    const message = output.lines.join("\n");
    expect(message).toContain("could not start");
    expect(message).toContain("spawn node EACCES");
    expect(message).not.toContain("Cannot find Node");
  });

  test("the default runner spawns the command it is given", () => {
    const root = workspace();

    const result = spawnStep(process.execPath, ["-e", "process.exit(0)"], { cwd: root, env: process.env });

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
  });

  test("clears a stale dump directory before the first run", () => {
    const root = workspace();
    const stale = join(root, ".v8cov");
    mkdirSync(stale);
    writeFileSync(join(stale, "coverage-1-0.json"), "{}");
    const seen: boolean[] = [];
    const run: Runner = () => {
      seen.push(existsSync(stale));
      return { status: 0 };
    };
    const output = collect();

    coverageE2e({ root, node: "node", platform: "linux", run, ...output });

    expect(seen[0]).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });
});
