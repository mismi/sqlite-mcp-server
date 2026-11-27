/**
 * The model-driven evaluation loop, separated from its CLI so it can be exercised without a
 * key, a model or a network: the loop takes the chat completions call and the tool call as
 * functions, and scripts/evals-model.test.ts drives both against a fake local endpoint.
 *
 * scripts/evals-model.ts wires this to a real endpoint and to the MCP server over stdio.
 */
import type { Pair } from "./eval-harness.ts";

const SYSTEM_PROMPT = [
  "You answer questions about the SQLite database behind the tools you are given.",
  "Discover the schema with sqlite_list_tables and sqlite_describe_table, then read rows with sqlite_query.",
  "Never guess a value: every number and name must come from a tool result.",
  "When you have the answer, reply with the answer only, in the exact form the question asks for."
].join(" ");

export interface ModelToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
}

/** A tool as the chat completions API expects it, built from the server's own inputSchema. */
export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/** One chat completion, returning the assistant message and what it cost in USD. */
export type Ask = (messages: ChatMessage[]) => Promise<{ message: ChatMessage; cost: number }>;

/** Runs one tool call and returns what the loop feeds back to the model. */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

export interface ChatClientOptions {
  /** Base URL before /chat/completions, e.g. https://freebuff.com/api/v1/paid. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The tools offered on every request; they stay the same for a whole run. */
  tools: ToolSchema[];
  inputPricePerMTok: number;
  outputPricePerMTok: number;
}

/**
 * A chat completions client whose usage block is required: without it the cost cap cannot be
 * enforced, so a response without usage is an error rather than a free turn.
 */
export function createChatClient(options: ChatClientOptions): Ask {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return async (messages) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        messages,
        tools: options.tools,
        tool_choice: "auto",
        temperature: 0
      })
    });
    if (!response.ok) {
      throw new Error(`${baseUrl}/chat/completions returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: ChatMessage }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error(`the model returned no message: ${JSON.stringify(body).slice(0, 300)}`);
    if (!body.usage) {
      throw new Error(
        "the response has no usage block, so the cost cap cannot be enforced; use an endpoint that reports token usage."
      );
    }
    const cost =
      ((body.usage.prompt_tokens ?? 0) / 1e6) * options.inputPricePerMTok +
      ((body.usage.completion_tokens ?? 0) / 1e6) * options.outputPricePerMTok;
    return { message, cost };
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A character that ends a word: anything that is not a letter or a digit, or the text's edge. */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}]/u.test(char);
}

/**
 * True when `answer` appears in `text` as whole words, so prose around it is allowed but a
 * longer value that merely contains it is not: "15" does not answer "5".
 */
function containsAnswer(text: string, answer: string): boolean {
  const haystack = normalize(text);
  const needle = normalize(answer);
  if (!needle) return false;
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + 1)) {
    if (isBoundary(haystack[from - 1]) && isBoundary(haystack[from + needle.length])) return true;
  }
  return false;
}

export interface ModelEvalOptions {
  pairs: Pair[];
  ask: Ask;
  callTool: CallTool;
  /** Assistant turns allowed per question before it counts as unanswered. */
  maxTurns: number;
  /** Budget for the whole run, in USD. */
  maxCostUsd: number;
  log?: (line: string) => void;
}

export interface ModelEvalResult {
  answered: number;
  failed: number;
  /** What the run spent, in USD. */
  spent: number;
}

async function toolMessage(call: ModelToolCall, callTool: CallTool, log: (line: string) => void): Promise<ChatMessage> {
  const raw = call.function.arguments?.trim() || "";
  let args: Record<string, unknown>;
  try {
    args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Feeding the mistake back lets the model retry with valid JSON instead of ending the run.
    return { role: "tool", tool_call_id: call.id, content: `Your arguments were not valid JSON: ${raw.slice(0, 200)}` };
  }
  log(`     ${call.function.name} ${raw.replace(/\s+/g, " ").slice(0, 120)}`);
  const result = await callTool(call.function.name, args);
  return { role: "tool", tool_call_id: call.id, content: result.isError ? `Tool error: ${result.text}` : result.text };
}

/**
 * All pairs, or only the one EVAL_ONLY names (1-based), so one question can be re-run cheaply.
 * Throws instead of exiting, so the CLI owns the message and a test can call it directly.
 */
export function selectPairs(pairs: Pair[], only: string | undefined): Pair[] {
  const raw = only?.trim();
  if (!raw) return pairs;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1 || number > pairs.length) {
    throw new Error(`EVAL_ONLY must be a question number between 1 and ${pairs.length}, got "${raw}".`);
  }
  return [pairs[number - 1]!];
}

/**
 * Asks every question, letting the model choose its tool calls, and counts the answers that
 * do not contain the expected one. Throws when the budget is spent; a question that never
 * answers within the turn cap only counts as failed, so the run reports every question.
 */
export async function runModelEvals(options: ModelEvalOptions): Promise<ModelEvalResult> {
  const { pairs, ask, callTool, maxTurns, maxCostUsd } = options;
  const log = options.log ?? (() => {});
  let spent = 0;
  let failed = 0;

  for (const [index, pair] of pairs.entries()) {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: pair.question }
    ];
    let answered = false;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      // Checked before each request, so an exhausted budget never buys another turn.
      if (spent >= maxCostUsd) {
        throw new Error(`cost cap reached at $${spent.toFixed(4)} of $${maxCostUsd} on question ${index + 1}`);
      }
      const { message, cost } = await ask(messages);
      spent += cost;
      if (spent > maxCostUsd) {
        throw new Error(`cost cap exceeded at $${spent.toFixed(4)} (budget $${maxCostUsd}) on question ${index + 1}`);
      }
      messages.push(message);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        const text = message.content ?? "";
        const ok = containsAnswer(text, pair.answer);
        log(
          `${ok ? "ok" : "fail"} ${index + 1}/${pairs.length} (${turn} turn(s), $${spent.toFixed(4)}): ${text.replace(/\s+/g, " ").slice(0, 120)}`
        );
        if (!ok) failed += 1;
        answered = true;
        break;
      }

      for (const call of calls) messages.push(await toolMessage(call, callTool, log));
    }

    if (!answered) {
      log(`fail ${index + 1}/${pairs.length}: no final answer within ${maxTurns} turn(s)`);
      failed += 1;
    }
  }

  return { answered: pairs.length - failed, failed, spent };
}
