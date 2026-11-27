/**
 * Offline tests for the model-driven evaluation loop: every case drives
 * scripts/eval-model-core.ts against a fake OpenAI chat completions endpoint on 127.0.0.1, so
 * the turn cap, the cost cap, the refusal of a response without a usage block and the failure
 * on a wrong answer are covered without a key, a model or any spend.
 *
 * The endpoint is a real HTTP server, so the request body, the response parsing and the cost
 * arithmetic are exercised as they are in a real run.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createChatClient,
  runModelEvals,
  selectPairs,
  type ChatMessage,
  type ModelToolCall,
  type ToolSchema
} from "./eval-model-core.ts";
import type { Pair } from "./eval-harness.ts";

const PAIRS: Pair[] = [
  { question: "which genre has the most titles", answer: "fiction, 11" },
  { question: "how many customers joined", answer: "5" }
];

const TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: { name: "sqlite_list_tables", description: "Lists tables", parameters: { type: "object" } }
  }
];

/** One canned reply: the body to send, and an optional HTTP status. */
interface Reply {
  body: unknown;
  status?: number;
}

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
});

/**
 * Starts a fake endpoint whose reply may depend on the request body and on how many requests
 * it has already answered. Returns its base URL and the request bodies it received.
 */
async function fakeEndpoint(reply: (request: { body: any; count: number }) => Reply) {
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const answer = reply({ body, count: requests.length });
      response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

/** A completion with the given assistant message and, unless omitted, a usage block. */
function completion(message: Partial<ChatMessage>, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    body: {
      choices: [{ message: { role: "assistant", content: null, ...message } }],
      ...(usage ? { usage } : {})
    }
  };
}

function toolCall(id: string): ModelToolCall {
  return { id, function: { name: "sqlite_list_tables", arguments: '{"response_format":"json"}' } };
}

/** The loop under test, with a tool stub that records what it was asked to run. */
function harness(baseUrl: string, overrides: { maxTurns?: number; maxCostUsd?: number } = {}) {
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  return {
    toolCalls,
    logs,
    run: (pairs: Pair[] = PAIRS) =>
      runModelEvals({
        pairs,
        // 1 USD per prompt MTok and 2 per completion MTok: 1000/500 tokens cost $0.002.
        ask: createChatClient({
          baseUrl,
          apiKey: "offline-test",
          model: "fake-model",
          tools: TOOLS,
          inputPricePerMTok: 1,
          outputPricePerMTok: 2
        }),
        callTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { text: "id | title\n1 | Americanah", isError: false };
        },
        maxTurns: overrides.maxTurns ?? 8,
        maxCostUsd: overrides.maxCostUsd ?? 0.25,
        log: (line) => logs.push(line)
      })
  };
}

test("EVAL_ONLY runs one question by its 1-based number, and all of them without it", () => {
  expect(selectPairs(PAIRS, "1")).toEqual([PAIRS[0]!]);
  expect(selectPairs(PAIRS, " 2 ")).toEqual([PAIRS[1]!]);
  expect(selectPairs(PAIRS, undefined)).toEqual(PAIRS);
  expect(selectPairs(PAIRS, "  ")).toEqual(PAIRS);
});

test("EVAL_ONLY is refused outside the questions or when it is not a whole number", () => {
  for (const only of ["0", "3", "-1", "1.5", "abc"]) {
    expect(() => selectPairs(PAIRS, only)).toThrow(
      `EVAL_ONLY must be a question number between 1 and 2, got "${only}".`
    );
  }
});

test("a correct answer passes and its cost comes from the usage block", async () => {
  const endpoint = await fakeEndpoint(() =>
    completion({ content: "Fiction, 11 — 11 titles." }, { prompt_tokens: 1000, completion_tokens: 500 })
  );
  const test_ = harness(endpoint.baseUrl);

  const result = await test_.run([PAIRS[0]!]);

  expect(result.answered).toBe(1);
  expect(result.failed).toBe(0);
  expect(result.spent).toBeCloseTo(0.002, 9);
  expect(test_.logs[0]).toStartWith("ok 1/1 (1 turn(s), $0.0020)");

  // The request carries the configured model, the system prompt and the tool schema.
  const request = endpoint.requests[0];
  expect(request.model).toBe("fake-model");
  expect(request.tools).toHaveLength(1);
  expect(request.tools[0].function.name).toBe("sqlite_list_tables");
  expect(request.messages[0]).toMatchObject({ role: "system" });
  expect(request.messages[1]).toEqual({ role: "user", content: PAIRS[0]!.question });
});

test("the answer counts as whole words inside prose", async () => {
  const endpoint = await fakeEndpoint(() =>
    completion({ content: "There are 5 customers here (joined before 2024)." }, { prompt_tokens: 10, completion_tokens: 5 })
  );
  const test_ = harness(endpoint.baseUrl);

  const result = await test_.run([PAIRS[1]!]);

  expect(result).toMatchObject({ answered: 1, failed: 0 });
});

test("a longer number that merely contains the answer does not count", async () => {
  // "15" contains "5": plain inclusion would accept it, a word boundary does not.
  const endpoint = await fakeEndpoint(() =>
    completion({ content: "The count is 15 customers." }, { prompt_tokens: 10, completion_tokens: 5 })
  );
  const test_ = harness(endpoint.baseUrl);

  const result = await test_.run([PAIRS[1]!]);

  expect(result).toMatchObject({ answered: 0, failed: 1 });
});

test("a wrong final answer fails the question", async () => {
  const endpoint = await fakeEndpoint(() => completion({ content: "nonfiction, 3" }, { prompt_tokens: 10, completion_tokens: 5 }));
  const test_ = harness(endpoint.baseUrl);

  const result = await test_.run([PAIRS[0]!]);

  expect(result).toMatchObject({ answered: 0, failed: 1 });
  expect(test_.logs[0]).toStartWith("fail 1/1");
});

test("tool calls are fed back to the model, then the answer is checked", async () => {
  const endpoint = await fakeEndpoint(({ count }) =>
    count === 1
      ? completion({ tool_calls: [toolCall("call_1")] }, { prompt_tokens: 1000, completion_tokens: 100 })
      : completion({ content: "fiction, 11" }, { prompt_tokens: 1200, completion_tokens: 100 })
  );
  const test_ = harness(endpoint.baseUrl);

  const result = await test_.run([PAIRS[0]!]);

  expect(result.answered).toBe(1);
  expect(result.failed).toBe(0);
  // $0.0012 for the tool-calling turn, $0.0014 for the answer that follows it.
  expect(result.spent).toBeCloseTo(0.0026, 9);
  expect(test_.toolCalls).toEqual([{ name: "sqlite_list_tables", args: { response_format: "json" } }]);
  // The tool result is sent back with the id of the call it answers.
  expect(endpoint.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "call_1",
    content: "id | title\n1 | Americanah"
  });
});

test("a question that never answers stops at the turn cap", async () => {
  const endpoint = await fakeEndpoint(({ count }) =>
    completion({ tool_calls: [toolCall(`call_${count}`)] }, { prompt_tokens: 10, completion_tokens: 5 })
  );
  const test_ = harness(endpoint.baseUrl, { maxTurns: 3 });

  const result = await test_.run([PAIRS[0]!]);

  expect(result).toMatchObject({ answered: 0, failed: 1 });
  expect(endpoint.requests).toHaveLength(3);
  expect(test_.toolCalls).toHaveLength(3);
  expect(test_.logs.at(-1)).toContain("no final answer within 3 turn(s)");
});

test("the run aborts once a response takes it over the cost cap", async () => {
  const endpoint = await fakeEndpoint(() =>
    completion({ content: "fiction, 11" }, { prompt_tokens: 1_000_000, completion_tokens: 0 })
  );
  // $1 per million prompt tokens, and $0.001 available: the first answer already overspends.
  const test_ = harness(endpoint.baseUrl, { maxCostUsd: 0.001 });

  await expect(test_.run([PAIRS[0]!])).rejects.toThrow(/cost cap exceeded at \$1\.0000 \(budget \$0\.001\)/);
  expect(endpoint.requests).toHaveLength(1);
});

test("a response without a usage block is refused instead of costing nothing", async () => {
  const endpoint = await fakeEndpoint(() => completion({ content: "fiction, 11" }));
  const test_ = harness(endpoint.baseUrl);

  await expect(test_.run([PAIRS[0]!])).rejects.toThrow(/no usage block/);
});

test("the run stops before the next question once the budget is spent", async () => {
  const endpoint = await fakeEndpoint(({ body }) => {
    const question = body.messages.at(-1).content;
    const pair = PAIRS.find((candidate) => candidate.question === question);
    return completion({ content: pair?.answer ?? "unknown" }, { prompt_tokens: 1000, completion_tokens: 0 });
  });
  // Each answer costs $0.001 and the budget is exactly $0.001, so question 2 must not be asked.
  const test_ = harness(endpoint.baseUrl, { maxCostUsd: 0.001 });

  await expect(test_.run()).rejects.toThrow(/cost cap reached at \$0\.0010 of \$0\.001 on question 2/);
  expect(endpoint.requests).toHaveLength(1);
});

test("invalid tool arguments are handed back instead of failing the run", async () => {
  const endpoint = await fakeEndpoint(({ count }) =>
    count === 1
      ? completion(
          { tool_calls: [{ id: "call_1", function: { name: "sqlite_list_tables", arguments: "{not json" } }] },
          { prompt_tokens: 10, completion_tokens: 5 }
        )
      : completion({ content: "fiction, 11" }, { prompt_tokens: 10, completion_tokens: 5 })
  );
  const test_ = harness(endpoint.baseUrl);

  const result = await test_.run([PAIRS[0]!]);

  expect(result).toMatchObject({ answered: 1, failed: 0 });
  expect(test_.toolCalls).toHaveLength(0);
  expect(endpoint.requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  expect(endpoint.requests[1].messages.at(-1).content).toStartWith("Your arguments were not valid JSON: {not json");
});

test("a failing endpoint aborts the run with its status", async () => {
  const endpoint = await fakeEndpoint(() => ({ status: 503, body: { error: "overloaded" } }));
  const test_ = harness(endpoint.baseUrl);

  await expect(test_.run([PAIRS[0]!])).rejects.toThrow(/returned 503: .*overloaded/);
});

test("the loop runs without a log sink", async () => {
  const endpoint = await fakeEndpoint(() => completion({ content: "fiction, 11" }, { prompt_tokens: 10, completion_tokens: 5 }));

  const result = await runModelEvals({
    pairs: [PAIRS[0]!],
    ask: createChatClient({
      baseUrl: endpoint.baseUrl,
      apiKey: "offline-test",
      model: "fake-model",
      tools: TOOLS,
      inputPricePerMTok: 1,
      outputPricePerMTok: 2
    }),
    callTool: async () => ({ text: "", isError: false }),
    maxTurns: 1,
    maxCostUsd: 0.25
  });

  expect(result).toMatchObject({ answered: 1, failed: 0 });
});
