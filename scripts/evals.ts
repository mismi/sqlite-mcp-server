/**
 * Replays every question of evals/evaluation.xml through the MCP server's own tools and
 * checks that the expected answer comes out of the tool responses.
 *
 * For each question the script plays the tool calls a model would make (list tables,
 * describe a table, query with named parameters) through a real stdio client, then
 * formats the answer from the last query's structured rows. A wrong schema, a broken
 * paging layer or a changed result therefore fails here instead of in a model run.
 *
 * One plan pages through rows with limit/offset instead of SQL, so the tools' has_more and
 * next_offset fields are exercised and the second page is requested with the offset the
 * first one returned.
 *
 * A negative test replays one plan with a deliberately wrong expected answer and requires
 * it to be rejected, so a green run proves the answers are actually compared.
 *
 * Run with: bun run build && bun run evals
 */
import { strict as assert } from "node:assert";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEMO_DB, loadPairs, toolText, type Pair } from "./eval-harness.ts";

type Row = Record<string, unknown>;
type Arguments = Record<string, unknown>;

type ToolCall = {
  tool: string;
  /** Static arguments, or a builder that receives the previous call's structured content. */
  arguments: Arguments | ((previous: Row | undefined) => Arguments);
  /** Extra assertions on this call's structured content, e.g. the pagination fields. */
  expect?: (page: Row) => void;
};

interface Plan {
  /** Lowercase fragment that identifies the question in the XML. */
  question: string;
  /** Tool calls a model would make to answer it; the last one must be a query. */
  calls: ToolCall[];
  /** Builds the answer string from the rows returned by the final query. */
  answer: (rows: Row[]) => string;
}

const listTables: ToolCall = { tool: "sqlite_list_tables", arguments: { response_format: "json" } };

function describe(table: string): ToolCall {
  return { tool: "sqlite_describe_table", arguments: { table, response_format: "json" } };
}

function query(sql: string, params?: Record<string, string | number>): ToolCall {
  return { tool: "sqlite_query", arguments: { sql, params: params ?? {}, response_format: "json" } };
}

/** The next_offset of the previous page, or a failure when it did not provide one. */
function nextOffset(previous: Row | undefined): number {
  const value = previous?.next_offset;
  assert.equal(typeof value, "number", "the previous page must return a numeric next_offset");
  return value as number;
}

/** The single row a "top 1" / aggregate query must return. */
function single(rows: Row[]): Row {
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}: ${JSON.stringify(rows)}`);
  return rows[0]!;
}

const money = (value: unknown): string => Number(value).toFixed(2);

const plans: Plan[] = [
  {
    question: "which genre has the most titles",
    calls: [
      listTables,
      describe("books"),
      query(
        `SELECT genre, COUNT(*) AS titles
         FROM books
         GROUP BY genre
         ORDER BY titles DESC, genre
         LIMIT 1`
      )
    ],
    answer: (rows) => {
      const row = single(rows);
      return `${row.genre}, ${row.titles}`;
    }
  },
  {
    question: "which author's books have generated the most revenue",
    calls: [
      listTables,
      describe("orders"),
      query(
        `SELECT a.name AS author, ROUND(SUM(o.total), 2) AS revenue
         FROM orders o
         JOIN books b ON b.id = o.book_id
         JOIN authors a ON a.id = b.author_id
         WHERE o.status = $status
         GROUP BY a.id
         ORDER BY revenue DESC
         LIMIT 1`,
        { status: "delivered" }
      )
    ],
    answer: (rows) => {
      const row = single(rows);
      return `${row.author}, ${money(row.revenue)}`;
    }
  },
  {
    question: "which single book has sold the most copies",
    calls: [
      listTables,
      query(
        `SELECT b.title AS title, SUM(o.quantity) AS copies
         FROM orders o
         JOIN books b ON b.id = o.book_id
         WHERE o.status = 'delivered'
         GROUP BY b.id
         ORDER BY copies DESC, b.title
         LIMIT 1`
      )
    ],
    answer: (rows) => {
      const row = single(rows);
      return `${row.title}, ${row.copies}`;
    }
  },
  {
    question: "how many customers joined",
    calls: [
      describe("customers"),
      query(`SELECT COUNT(*) AS customers FROM customers WHERE joined < $cutoff`, { cutoff: "2024-01-01" })
    ],
    answer: (rows) => `${single(rows).customers}`
  },
  {
    question: "combined value of all orders that are still pending",
    calls: [describe("orders"), query(`SELECT ROUND(SUM(total), 2) AS value FROM orders WHERE status = $status`, { status: "pending" })],
    answer: (rows) => money(single(rows).value)
  },
  {
    question: "fewest copies left in stock",
    calls: [describe("books"), query(`SELECT title, stock FROM books ORDER BY stock, title LIMIT 1`)],
    answer: (rows) => {
      const row = single(rows);
      return `${row.title}, ${row.stock}`;
    }
  },
  {
    question: "customer living in lagos",
    calls: [
      describe("customers"),
      query(
        `SELECT c.name AS customer, SUM(o.quantity) AS copies
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         WHERE o.status = 'delivered' AND c.city = $city
         GROUP BY c.id
         ORDER BY copies DESC
         LIMIT 1`,
        { city: "Lagos" }
      )
    ],
    answer: (rows) => {
      const row = single(rows);
      return `${row.customer}, ${row.copies}`;
    }
  },
  {
    question: "at least one book whose copies have never been sold",
    calls: [
      listTables,
      query(
        `SELECT DISTINCT a.name AS author
         FROM authors a
         JOIN books b ON b.author_id = a.id
         WHERE b.id NOT IN (SELECT book_id FROM orders WHERE status = 'delivered')
         ORDER BY a.name`
      )
    ],
    answer: (rows) => rows.map((row) => String(row.author)).join(", ")
  },
  {
    question: "average price of the books published before 1980",
    calls: [
      describe("books"),
      query(`SELECT ROUND(AVG(price), 2) AS average FROM books WHERE published < $year`, { year: 1980 })
    ],
    answer: (rows) => money(single(rows).average)
  },
  {
    question: "which genre brought in the most revenue",
    calls: [
      describe("sales_by_book"),
      query(
        `SELECT b.genre AS genre, ROUND(SUM(o.total), 2) AS revenue
         FROM orders o
         JOIN books b ON b.id = o.book_id
         WHERE o.status = 'delivered'
         GROUP BY b.genre
         ORDER BY revenue DESC
         LIMIT 1`
      )
    ],
    answer: (rows) => {
      const row = single(rows);
      return `${row.genre}, ${money(row.revenue)}`;
    }
  },
  {
    question: "third and fourth",
    calls: [
      listTables,
      {
        tool: "sqlite_query",
        arguments: { sql: "SELECT title FROM books ORDER BY title", limit: 2, offset: 0, response_format: "json" },
        // Paged through the tool rather than with SQL: the first page must announce the second.
        expect: (page) => {
          assert.equal(page.has_more, true, "the first page must report that more books exist");
          assert.equal(page.next_offset, 2, "the first page must hand back offset 2 for the next call");
        }
      },
      {
        tool: "sqlite_query",
        arguments: (previous) => ({
          sql: "SELECT title FROM books ORDER BY title",
          limit: 2,
          offset: nextOffset(previous),
          response_format: "json"
        }),
        expect: (page) => {
          assert.equal(page.offset, 2, "the second page must start where the first one ended");
          assert.equal(page.count, 2, "the second page must hold two books");
          assert.equal(page.has_more, true, "22 books leave more pages after this one");
          assert.equal(page.next_offset, 4, "the second page must hand back offset 4");
        }
      }
    ],
    answer: (rows) => rows.map((row) => String(row.title)).join(", ")
  }
];

const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-evals-"));
const testDb = join(workDir, "demo.db");
copyFileSync(DEMO_DB, testDb);

const pairs = loadPairs();
assert.equal(
  plans.length,
  pairs.length,
  `the evaluation file has ${pairs.length} question(s) but the replay plans cover ${plans.length}`
);

/** The plan whose question fragment appears in `question`. */
function planFor(question: string, index: number): Plan {
  const plan = plans.find((candidate) => question.toLowerCase().includes(candidate.question));
  assert.ok(plan, `question ${index + 1} has no replay plan: ${question}`);
  return plan;
}

/** Plays a plan's tool calls, then fails unless they produce the expected answer. */
async function replay(plan: Plan, pair: Pair, index: number): Promise<void> {
  let rows: Row[] = [];
  let previous: Row | undefined;
  for (const call of plan.calls) {
    const args = typeof call.arguments === "function" ? call.arguments(previous) : call.arguments;
    const result = await client.callTool({ name: call.tool, arguments: args });
    assert.ok(!result.isError, `${call.tool} failed for question ${index + 1}: ${toolText(result)}`);
    const payload = result.structuredContent as Row | undefined;
    assert.ok(payload, `${call.tool} returned no structured content in json mode`);
    call.expect?.(payload);
    if (call.tool === "sqlite_query") {
      const { rows: returned } = payload as { rows?: unknown };
      assert.ok(Array.isArray(returned), `${call.tool} returned no rows`);
      rows = returned as Row[];
    }
    previous = payload;
  }
  const actual = plan.answer(rows);
  assert.equal(actual, pair.answer, `wrong answer through the tools for question ${index + 1}: ${pair.question}`);
  console.error(`ok ${index + 1}/${pairs.length}  ${actual}`);
}

const client = new Client({ name: "sqlite-mcp-evals", version: "1.0.0" });

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), SQLITE_DB_PATH: testDb }
    })
  );

  const used = new Set<string>();

  for (const [index, pair] of pairs.entries()) {
    const plan = planFor(pair.question, index);
    assert.ok(!used.has(plan.question), `two questions share the replay plan for "${plan.question}"`);
    used.add(plan.question);
    await replay(plan, pair, index);
  }

  // Negative test: replaying the same plan against a wrong expected answer must fail, so a
  // green run proves the harness compares answers instead of merely running.
  const first = pairs[0]!;
  await assert.rejects(
    replay(planFor(first.question, 0), { ...first, answer: "wrong on purpose" }, 0),
    /wrong answer through the tools/,
    "a deliberately wrong answer must be rejected"
  );
  console.error("ok negative: a wrong expected answer is rejected");

  console.error(`Evaluations passed (${pairs.length}/${pairs.length})`);
} finally {
  await client.close();
  rmSync(workDir, { recursive: true, force: true });
}
