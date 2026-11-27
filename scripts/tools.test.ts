/**
 * Contract tests for the real server: createServer() is mounted on a linked pair of
 * in-memory transports, so the five tools and the sqlite://schema resource are exercised
 * through a real MCP client without spawning a process or touching data/demo.db.
 *
 * What is checked here is the surface a model and a host depend on: tool names,
 * descriptions, inputSchema shape (required fields, defaults, response_format, paging
 * bounds), annotations, and the exact keys each structuredContent carries. Behaviour that
 * spans processes (stdio, HTTP, Host/Origin) stays in scripts/smoke.ts.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DEFAULT_DB_PATH } from "../src/constants.js";
import { closeDb } from "../src/db.js";
import { createServer } from "../src/server.js";

const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-tools-test-"));
const testDb = join(workDir, "demo.db");
copyFileSync(DEFAULT_DB_PATH, testDb);
process.env.SQLITE_DB_PATH = testDb;

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "sqlite-mcp-tools-test", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

/** A tool result reduced to the two things the contract is about: text and structured data. */
async function callWith(target: Client, name: string, args: Record<string, unknown>) {
  const result = await target.callTool({ name, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return {
    isError: Boolean(result.isError),
    text: content.map((block) => block.text ?? "").join("\n"),
    structured: result.structuredContent as Record<string, any> | undefined
  };
}

const call = (name: string, args: Record<string, unknown>) => callWith(client, name, args);

type ToolResult = Awaited<ReturnType<typeof call>>;

/** A tool error must be flagged, carry an actionable message, and never ship structured data. */
function expectToolError(result: ToolResult, ...parts: string[]): void {
  expect(result.isError).toBe(true);
  for (const part of parts) expect(result.text).toContain(part);
  expect(result.structured).toBeUndefined();
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, { type?: string; enum?: string[]; default?: unknown; minimum?: number; maximum?: number }>;
  required?: string[];
  additionalProperties?: boolean;
};

const TOOL_NAMES = [
  "sqlite_describe_table",
  "sqlite_execute",
  "sqlite_insert_row",
  "sqlite_list_tables",
  "sqlite_query"
];

test("the server advertises the five tools with usable metadata", async () => {
  const { tools } = await client.listTools();

  expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
  for (const tool of tools) {
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    const schema = tool.inputSchema as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema as JsonSchema]));
  expect(byName.get("sqlite_describe_table")!.required).toContain("table");
  expect(byName.get("sqlite_query")!.required).toContain("sql");
  expect(byName.get("sqlite_execute")!.required).toContain("sql");
  expect(byName.get("sqlite_insert_row")!.required).toEqual(expect.arrayContaining(["table", "values"]));

  // The read tools share one response_format schema; the write tools return JSON only.
  for (const name of ["sqlite_list_tables", "sqlite_describe_table", "sqlite_query"]) {
    const format = byName.get(name)!.properties!.response_format!;
    expect(format.enum).toEqual(["markdown", "json"]);
    expect(format.default).toBe("markdown");
  }

  // Paging is declared in the schema, so a host can see the bounds before calling.
  expect(byName.get("sqlite_list_tables")!.properties!.limit).toMatchObject({
    type: "integer",
    default: 50,
    minimum: 1,
    maximum: 200
  });
  expect(byName.get("sqlite_query")!.properties!.limit).toMatchObject({
    type: "integer",
    default: 50,
    minimum: 1,
    maximum: 500
  });
  for (const name of ["sqlite_list_tables", "sqlite_query"]) {
    expect(byName.get(name)!.properties!.offset).toMatchObject({ type: "integer", default: 0, minimum: 0 });
  }
});

test("tool annotations separate reads from writes", async () => {
  const { tools } = await client.listTools();
  const annotations = new Map(tools.map((tool) => [tool.name, tool.annotations]));

  for (const name of ["sqlite_list_tables", "sqlite_describe_table", "sqlite_query"]) {
    expect(annotations.get(name)).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  }
  expect(annotations.get("sqlite_insert_row")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  expect(annotations.get("sqlite_execute")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
});

test("sqlite_list_tables returns one page of objects with counts", async () => {
  const { isError, structured } = await call("sqlite_list_tables", { response_format: "json" });

  expect(isError).toBe(false);
  expect(structured!.database).toContain("sqlite-mcp-tools-test-");
  expect(structured!.total).toBe(5);
  expect(structured!.count).toBe(5);
  expect(structured!.offset).toBe(0);
  expect(structured!.has_more).toBe(false);
  expect(structured).not.toHaveProperty("next_offset");

  const objects = structured!.objects as { name: string; type: string; row_count: number; column_count: number }[];
  expect(objects.map((object) => object.name).sort()).toEqual([
    "authors",
    "books",
    "customers",
    "orders",
    "sales_by_book"
  ]);
  for (const object of objects) {
    expect(["table", "view"]).toContain(object.type);
    expect(Number.isInteger(object.row_count)).toBe(true);
    expect(Number.isInteger(object.column_count)).toBe(true);
  }
});

test("sqlite_list_tables pages with limit/offset and reports next_offset", async () => {
  const { structured } = await call("sqlite_list_tables", { limit: 2, offset: 1, response_format: "json" });

  expect(structured!.count).toBe(2);
  expect(structured!.offset).toBe(1);
  expect(structured!.has_more).toBe(true);
  expect(structured!.next_offset).toBe(3);
});

test("sqlite_describe_table returns columns, keys, indexes and DDL", async () => {
  const { isError, structured } = await call("sqlite_describe_table", { table: "books", response_format: "json" });

  expect(isError).toBe(false);
  expect(structured!.table).toBe("books");
  expect(structured!.type).toBe("table");
  expect(Number.isInteger(structured!.row_count)).toBe(true);

  const columns = structured!.columns as { name: string; type: string; nullable: boolean; default: unknown; primary_key: boolean }[];
  expect(columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(["id", "title", "author_id", "genre", "published", "price", "stock"])
  );
  expect(columns.filter((column) => column.primary_key)).toHaveLength(1);
  for (const column of columns) {
    expect(typeof column.type).toBe("string");
    expect(typeof column.nullable).toBe("boolean");
    expect(typeof column.primary_key).toBe("boolean");
  }

  const foreignKeys = structured!.foreign_keys as { column: string; references_table: string; references_column: string }[];
  expect(foreignKeys.find((key) => key.column === "author_id")).toMatchObject({ references_table: "authors" });

  const indexes = structured!.indexes as { name: string; unique: boolean; columns: string[] }[];
  expect(Array.isArray(indexes)).toBe(true);
  for (const index of indexes) {
    expect(typeof index.name).toBe("string");
    expect(typeof index.unique).toBe("boolean");
    expect(Array.isArray(index.columns)).toBe(true);
  }

  expect(structured!.ddl).toContain("CREATE TABLE books");
});

test("a table name is resolved case-insensitively and echoes the real name", async () => {
  const { structured } = await call("sqlite_describe_table", { table: "BOOKS", response_format: "json" });

  expect(structured!.table).toBe("books");
});

test("sqlite_query returns columns, rows and paging in JSON, text only in markdown", async () => {
  const json = await call("sqlite_query", {
    sql: "SELECT title, price FROM books ORDER BY id LIMIT 2",
    response_format: "json"
  });

  expect(json.isError).toBe(false);
  expect(json.structured!.columns).toEqual(["title", "price"]);
  expect(json.structured!.count).toBe(2);
  expect(json.structured!.rows).toHaveLength(2);
  expect(json.structured!.rows[0]).toEqual({ title: expect.any(String), price: expect.any(Number) });
  expect(json.structured!.has_more).toBe(false);

  const markdown = await call("sqlite_query", { sql: "SELECT title FROM books ORDER BY id LIMIT 1" });
  expect(markdown.structured).toBeUndefined();
  expect(markdown.text).toContain("| title |");
});

test("sqlite_insert_row returns the stored row, and sqlite_execute returns its counters", async () => {
  const insert = await call("sqlite_insert_row", {
    table: "books",
    values: { title: "Contract Test Book", author_id: 1, genre: "fiction", published: 2026, price: 1.5, stock: 1 }
  });

  expect(insert.isError).toBe(false);
  expect(insert.structured!.table).toBe("books");
  const inserted = insert.structured!.inserted as { id: number; title: string; stock: number };
  expect(inserted).toMatchObject({ title: "Contract Test Book", stock: 1 });
  expect(inserted.id).toBeGreaterThan(22);
  // The row comes back as SQLite stored it, defaults included.
  expect(Object.keys(inserted)).toEqual(expect.arrayContaining(["id", "title", "author_id", "genre", "published", "price", "stock"]));

  const update = await call("sqlite_execute", {
    sql: "UPDATE books SET stock = stock + 2 WHERE id = $id",
    params: { id: inserted.id }
  });
  expect(update.isError).toBe(false);
  expect(update.structured).toEqual({ changes: 1, last_insert_rowid: null });

  const stock = await call("sqlite_query", {
    sql: "SELECT stock FROM books WHERE id = $id",
    params: { id: inserted.id },
    response_format: "json"
  });
  expect(stock.structured!.rows[0]).toEqual({ stock: 3 });

  // An INSERT through the same tool is where last_insert_rowid is meaningful.
  const executeInsert = await call("sqlite_execute", {
    sql: "INSERT INTO books (title, author_id, genre, published, price, stock) VALUES ($title, 1, 'fiction', 2026, 1.5, 1)",
    params: { title: "Execute Test Book" }
  });
  expect(executeInsert.structured!.changes).toBe(1);
  expect(executeInsert.structured!.last_insert_rowid).toBeGreaterThan(inserted.id);

  // REPLACE also stores a row, so it reports the id it wrote.
  const replace = await call("sqlite_execute", {
    sql: "REPLACE INTO books (id, title, author_id, genre, published, price, stock) VALUES ($id, 'Replaced Book', 1, 'fiction', 2026, 1.5, 1)",
    params: { id: inserted.id }
  });
  expect(replace.structured!.last_insert_rowid).toBe(inserted.id);

  // DELETE stores nothing: the id of the earlier INSERT must not leak through.
  const removed = await call("sqlite_execute", { sql: "DELETE FROM books WHERE id = $id", params: { id: inserted.id } });
  expect(removed.structured).toEqual({ changes: 1, last_insert_rowid: null });
});

test("error paths are tool errors with an actionable message and no structuredContent", async () => {
  const refused = await call("sqlite_query", { sql: "DELETE FROM books" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("only runs read-only queries");
  expect(refused.text).toContain('starts with "DELETE"');
  expect(refused.text).toContain("sqlite_execute");
  expect(refused.structured).toBeUndefined();

  const badColumn = await call("sqlite_insert_row", { table: "books", values: { titel: "Typo" } });
  expect(badColumn.isError).toBe(true);
  expect(badColumn.text).toContain('Unknown column(s) on "books": titel.');
  expect(badColumn.text).toContain("Available columns:");
  expect(badColumn.text).toContain("title");
  expect(badColumn.structured).toBeUndefined();

  const missingTable = await call("sqlite_query", { sql: "SELECT * FROM missing_table" });
  expect(missingTable.isError).toBe(true);
  expect(missingTable.text).toContain("no such table: missing_table");
  expect(missingTable.text).toContain("Available objects:");
  expect(missingTable.text).toContain("books");
  expect(missingTable.text).toContain("sqlite_list_tables");
  expect(missingTable.structured).toBeUndefined();

  const unknownTable = await call("sqlite_insert_row", { table: "nope", values: { title: "Dune" } });
  expect(unknownTable.isError).toBe(true);
  expect(unknownTable.text).toContain('No table or view named "nope".');
  expect(unknownTable.text).toContain("Available objects:");
  expect(unknownTable.structured).toBeUndefined();
});

// The wording itself is pinned in scripts/db.test.ts; here only the hint that has to survive
// the trip to the client is checked.
test("database errors reach the client flagged, with their hint, and without structuredContent", async () => {
  expectToolError(
    await call("sqlite_query", { sql: "SELECT missing_column FROM books" }),
    "sqlite_describe_table"
  );

  expectToolError(
    await call("sqlite_execute", {
      sql: "INSERT INTO books (title, author_id, genre, published, price, stock) VALUES ('Orphan', $author, 'fiction', 2026, 1, 1)",
      params: { author: 999 }
    }),
    "sqlite_describe_table"
  );

  // The demo schema has no UNIQUE column, so make one in the throwaway copy.
  await call("sqlite_execute", { sql: "CREATE TABLE unique_probe (value TEXT UNIQUE)" });
  const first = await call("sqlite_execute", { sql: "INSERT INTO unique_probe (value) VALUES ('a')" });
  expect(first.isError).toBe(false);

  expectToolError(
    await call("sqlite_execute", { sql: "INSERT INTO unique_probe (value) VALUES ('a')" }),
    "already exists"
  );
});

test("a missing database is reported with its path and the fix", async () => {
  const absent = join(workDir, "absent.db");
  closeDb();
  process.env.SQLITE_DB_PATH = absent;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const missingClient = new Client({ name: "sqlite-mcp-missing-db-test", version: "1.0.0" });
  await missingClient.connect(clientTransport);

  try {
    // The wording is pinned in db.test.ts; what matters here is that the path and the fix arrive.
    expectToolError(await callWith(missingClient, "sqlite_list_tables", {}), "absent.db", "SQLITE_DB_PATH", "bun run seed");
  } finally {
    await missingClient.close();
    closeDb();
    process.env.SQLITE_DB_PATH = testDb;
  }
});

test("64-bit integers beyond Number.MAX_SAFE_INTEGER keep their exact value", async () => {
  const { isError, structured } = await call("sqlite_query", {
    sql: "SELECT 9007199254740993 AS big, -9007199254740993 AS negative, 42 AS small",
    response_format: "json"
  });

  expect(isError).toBe(false);
  // Above 2^53 a JSON number would be rounded, so these come back as exact strings.
  expect(structured!.rows[0]).toEqual({ big: "9007199254740993", negative: "-9007199254740993", small: 42 });
});

test("the read tools render markdown and omit structuredContent", async () => {
  const list = await call("sqlite_list_tables", {});
  expect(list.structured).toBeUndefined();
  expect(list.text).toContain("- **books** — table");

  // One page with more behind it: the text must point at the next offset.
  const paged = await call("sqlite_list_tables", { limit: 2 });
  expect(paged.text).toContain("call again with offset=2");

  const describe = await call("sqlite_describe_table", { table: "books" });
  expect(describe.structured).toBeUndefined();
  expect(describe.text).toContain("**Foreign keys:**");
  expect(describe.text).toContain("**Indexes:**");
  expect(describe.text).toContain("## DDL");

  const empty = await call("sqlite_query", { sql: "SELECT title FROM books WHERE id = -1" });
  expect(empty.structured).toBeUndefined();
  expect(empty.text).toContain("returned no rows");
  expect(empty.text).toContain("Columns: title");
});

test("markdown output truncates a long cell instead of blowing up the page", async () => {
  // 200 characters, so escapeCell must cut it at 117 and add an ellipsis.
  const { text } = await call("sqlite_query", { sql: "SELECT replace(hex(zeroblob(100)), '0', 'x') AS long" });
  const row = text.split("\n").find((line) => line.startsWith("| x"));

  expect(row).toBeDefined();
  expect(row!.endsWith("... |")).toBe(true);
  expect(row!.length).toBeLessThan(200);
});

test("an oversized page is trimmed to the text limit, with structuredContent matching", async () => {
  // 300 rows of ~120 characters: more than the 25 000-character budget the tools cap text at.
  const huge = await call("sqlite_query", {
    sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 300) " +
      "SELECT x, replace(hex(zeroblob(60)), '0', 'x') AS pad FROM n",
    limit: 500,
    response_format: "json"
  });

  expect(huge.isError).toBe(false);
  expect(huge.text.length).toBeLessThanOrEqual(25_000);
  // Rows were dropped, and the pagination fields describe exactly what came back.
  expect(huge.structured!.count).toBeLessThan(300);
  expect(huge.structured!.rows).toHaveLength(huge.structured!.count);
  expect(huge.structured!.has_more).toBe(true);
  expect(huge.structured!.next_offset).toBe(huge.structured!.count);
});

test("sqlite_list_tables says so when the database has no objects", async () => {
  // An empty file is a valid, empty SQLite database: sqlite_master has no rows.
  const emptyDb = join(workDir, "empty.db");
  writeFileSync(emptyDb, "");
  closeDb();
  process.env.SQLITE_DB_PATH = emptyDb;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const emptyClient = new Client({ name: "sqlite-mcp-empty-db-test", version: "1.0.0" });
  await emptyClient.connect(clientTransport);

  try {
    const result = await emptyClient.callTool({ name: "sqlite_list_tables", arguments: {} });
    const text = ((result.content ?? []) as { text?: string }[]).map((block) => block.text ?? "").join("\n");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text).toContain("- (none)");
    expect(text).toContain("Showing 0 of 0");
  } finally {
    await emptyClient.close();
    closeDb();
    process.env.SQLITE_DB_PATH = testDb;
  }
});

test("the sqlite://schema resource describes the whole database", async () => {
  const { resources } = await client.listResources();

  expect(resources).toHaveLength(1);
  expect(resources[0]).toMatchObject({
    uri: "sqlite://schema",
    name: "sqlite-schema",
    title: "Database schema",
    mimeType: "text/plain"
  });
  expect(resources[0]!.description).toContain("CREATE");

  const read = await client.readResource({ uri: "sqlite://schema" });
  const content = read.contents[0] as { uri: string; mimeType?: string; text?: string };

  expect(content.uri).toBe("sqlite://schema");
  expect(content.mimeType).toBe("text/plain");
  expect(content.text).toContain("CREATE TABLE authors");
  expect(content.text).toContain("CREATE TABLE books");
  expect(content.text).toContain("CREATE TABLE orders");
  expect(content.text).toContain("CREATE VIEW sales_by_book");
});
