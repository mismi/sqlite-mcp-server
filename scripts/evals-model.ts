/**
 * Model-driven evaluation runner: the model chooses the tool calls itself, bounded by a turn
 * cap per question and a cost cap for the whole run, and its final message is checked against
 * the expected answer in evals/evaluation.xml.
 *
 * scripts/evals.ts stays the deterministic regression gate (it replays fixed plans and runs
 * in CI); this runner answers a different question: can a model actually drive the tools to
 * the answer, and what does it spend doing so?
 *
 * The loop and the endpoint client live in scripts/eval-model-core.ts, so
 * scripts/evals-model.test.ts can drive them against a fake endpoint without a key or spend;
 * this file only wires them to a real endpoint and to the MCP server over stdio.
 *
 * The endpoint must speak the OpenAI chat completions API with tool calling and report a
 * usage block, because the cost cap is computed from it.
 *
 * Configuration (environment):
 *   EVAL_MODEL                  model name to send (required)
 *   EVAL_ONLY                   run only this question number (1-based), for iterating cheaply
 *   EVAL_API_KEY                bearer token (required)
 *   EVAL_API_BASE_URL           base URL before /chat/completions
 *                               (default https://freebuff.com/api/v1/paid)
 *   EVAL_MAX_TURNS              assistant turns per question (default 8)
 *   EVAL_MAX_COST_USD           budget for the whole run (default 0.25)
 *   EVAL_PRICE_INPUT_PER_MTOK   USD per million prompt tokens (default 0.15)
 *   EVAL_PRICE_OUTPUT_PER_MTOK  USD per million completion tokens (default 0.60)
 *
 * Run with: bun run build && bun run evals:model
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createChatClient, runModelEvals, selectPairs, type ToolSchema } from "./eval-model-core.ts";
import { DEMO_DB, loadPairs, toolText, type Pair } from "./eval-harness.ts";

const DEFAULT_BASE_URL = "https://freebuff.com/api/v1/paid";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}".`);
  }
  return value;
}

function missingConfiguration(): void {
  const missing = ["EVAL_API_KEY", "EVAL_MODEL"].filter((name) => !process.env[name]?.trim());
  if (missing.length === 0) return;
  console.error(
    `Set ${missing.join(" and ")} to run the model evaluations, e.g.\n` +
      "  EVAL_API_KEY=... EVAL_MODEL=... bun run evals:model\n" +
      'See "Model-driven evaluations" in README.md.'
  );
  process.exit(1);
}

missingConfiguration();

const BASE_URL = process.env.EVAL_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
const API_KEY = process.env.EVAL_API_KEY!.trim();
const MODEL = process.env.EVAL_MODEL!.trim();
const MAX_TURNS = envNumber("EVAL_MAX_TURNS", 8);
const MAX_COST = envNumber("EVAL_MAX_COST_USD", 0.25);

/** EVAL_ONLY, reported as a message rather than a stack trace when it names no question. */
function selectedPairs(): Pair[] {
  try {
    return selectPairs(loadPairs(), process.env.EVAL_ONLY);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const pairs = selectedPairs();
const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-evals-model-"));
const testDb = join(workDir, "demo.db");
copyFileSync(DEMO_DB, testDb);

const client = new Client({ name: "sqlite-mcp-evals-model", version: "1.0.0" });

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), SQLITE_DB_PATH: testDb }
    })
  );

  const listed = await client.listTools();
  const tools: ToolSchema[] = listed.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema
    }
  }));

  const result = await runModelEvals({
    pairs,
    ask: createChatClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      tools,
      inputPricePerMTok: envNumber("EVAL_PRICE_INPUT_PER_MTOK", 0.15),
      outputPricePerMTok: envNumber("EVAL_PRICE_OUTPUT_PER_MTOK", 0.6)
    }),
    callTool: async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      return { text: toolText(response), isError: Boolean(response.isError) };
    },
    maxTurns: MAX_TURNS,
    maxCostUsd: MAX_COST,
    log: (line) => console.error(line)
  });

  console.error(
    `\nModel evaluations: ${result.answered}/${pairs.length} answered, spent $${result.spent.toFixed(4)} of $${MAX_COST}.`
  );
  if (result.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Model evaluations aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close();
  rmSync(workDir, { recursive: true, force: true });
}
