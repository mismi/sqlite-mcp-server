/**
 * Offline tests for the wiring in scripts/evals-model.ts: each case runs the real script in a
 * child process with a sanitized environment, so a missing EVAL_MODEL or EVAL_API_KEY, an
 * EVAL_ONLY that names no question and a non-numeric EVAL_MAX_TURNS or EVAL_MAX_COST_USD are
 * rejected before the script reads the database, starts the MCP server or calls an endpoint.
 * No key, no dist build and no network.
 *
 * The environment is rebuilt from scratch (minus every EVAL_* variable) so the developer's own
 * settings cannot make a case pass or fail by accident.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "evals-model.ts");

/** Runs the CLI with only the caller's non-EVAL_* environment plus the given overrides. */
async function runCli(overrides: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("EVAL_")) env[name] = value;
  }
  const child = Bun.spawn([process.execPath, SCRIPT], {
    env: { ...env, ...overrides },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { exitCode, stdout, stderr };
}

test("the CLI refuses to run without EVAL_MODEL or EVAL_API_KEY", async () => {
  const cases: { overrides: Record<string, string>; expected: string }[] = [
    { overrides: {}, expected: "Set EVAL_API_KEY and EVAL_MODEL to run the model evaluations" },
    { overrides: { EVAL_MODEL: "test-model" }, expected: "Set EVAL_API_KEY to run the model evaluations" },
    { overrides: { EVAL_API_KEY: "test-key" }, expected: "Set EVAL_MODEL to run the model evaluations" }
  ];

  for (const { overrides, expected } of cases) {
    const result = await runCli(overrides);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(expected);
    // The refusal happens before the endpoint client exists, so nothing is sent anywhere.
    expect(result.stderr).not.toContain("aborted");
    expect(result.stdout).toBe("");
  }
});

test("the CLI refuses any EVAL_ONLY that names no question", async () => {
  // Above the last question, below the first one, fractional, and not a number at all.
  for (const only of ["99", "0", "1.5", "abc"]) {
    const result = await runCli({
      EVAL_API_KEY: "test-key",
      EVAL_MODEL: "test-model",
      EVAL_ONLY: only,
      // An endpoint that cannot answer: reaching it would abort with a connection error.
      EVAL_API_BASE_URL: "http://127.0.0.1:1"
    });

    expect(result.exitCode).toBe(1);
    const message = result.stderr.trim();
    expect(message.startsWith("EVAL_ONLY must be a question number between 1 and ")).toBe(true);
    expect(message.endsWith(`got "${only}".`)).toBe(true);
    // Only the refusal is printed: no server log, no endpoint attempt.
    expect(message.split("\n")).toHaveLength(1);
    expect(result.stderr).not.toContain("aborted");
    expect(result.stdout).toBe("");
  }
});

test("the CLI rejects a non-numeric cap instead of falling back to the default", async () => {
  const cases = [
    { name: "EVAL_MAX_TURNS", value: "abc" },
    { name: "EVAL_MAX_COST_USD", value: "cheap" }
  ];

  for (const { name, value } of cases) {
    const result = await runCli({ EVAL_API_KEY: "test-key", EVAL_MODEL: "test-model", [name]: value });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${name} must be a non-negative number, got "${value}".`);
    expect(result.stderr).not.toContain("aborted");
    expect(result.stdout).toBe("");
  }
});
