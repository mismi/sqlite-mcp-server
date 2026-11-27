/**
 * Self-check: starts the built server against a throwaway copy of the demo database, exercises
 * every tool and the schema resource over stdio, then starts it again with TRANSPORT=http on a
 * loopback port and drives the /mcp endpoint with the client SDK's Streamable HTTP transport, so
 * no JSON-RPC envelope or SSE framing is re-implemented here. Exits non-zero on failure.
 *
 * Run with: bun run build && bun run smoke
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Resolved locally so the script has no TypeScript imports of its own and also runs on
// plain Node (Bun remaps "./x.js" to "./x.ts", Node does not).
const DEMO_DB = join(import.meta.dirname, "..", "data", "demo.db");

const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-smoke-"));
const testDb = join(workDir, "demo.db");
copyFileSync(DEMO_DB, testDb);

const client = new Client({ name: "sqlite-mcp-smoke", version: "1.0.0" });

function text(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content.map((block) => block.text ?? "").join("\n");
}

/** A loopback port that was free a moment ago, so the HTTP run cannot clash with another server. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Wraps fetch to record the status of every POST, so the check still sees /mcp answer 200, and
 * bounds each request in time while keeping the transport's own cancellation signal.
 */
function statusRecorder(statuses: number[]): FetchLike {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(10_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(input, { ...init, signal });
    if (init?.method === "POST") statuses.push(response.status);
    return response;
  };
}

/**
 * Connects the client SDK's Streamable HTTP transport to /mcp, retrying while the server starts.
 * The probe is the real initialize handshake, performed by the SDK: a startup banner or an open
 * port alone does not prove the endpoint answers JSON-RPC.
 */
async function connectHttp(
  url: URL,
  recordStatus: FetchLike,
  stopped: () => boolean,
  logs: () => string
): Promise<Client> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const client = new Client({ name: "sqlite-mcp-smoke-http", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { fetch: recordStatus }));
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (stopped() || Date.now() > deadline) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`the HTTP server never answered on ${url}: ${reason}\n${logs().trim()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * A POST with the headers written as given, so the check can send a foreign `Host` or `Origin`
 * the way a browser would; fetch() refuses to set `Host`, which is the whole point here.
 */
function rawPost(
  port: number,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        setHost: false,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/**
 * Starts the built server with TRANSPORT=http on a loopback port, initializes it, calls a tool
 * and checks that a foreign Origin or Host is refused, then stops it. The database is the same
 * throwaway copy.
 */
async function smokeHttp(testDb: string): Promise<void> {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    // NODE_V8_COVERAGE is forwarded by hand: getDefaultEnvironment() drops it, and this child is
    // the only one that runs the HTTP branch of the end-to-end coverage report.
    env: {
      ...getDefaultEnvironment(),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      SQLITE_DB_PATH: testDb,
      TRANSPORT: "http",
      PORT: String(port)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let logs = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    logs += chunk;
  });

  const statuses: number[] = [];
  // A real initialize body for the raw probes below: fetch() cannot set Host, so the Origin and
  // Host refusals still go through node:http with the headers written as given.
  const initializeBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sqlite-mcp-smoke", version: "1.0.0" } }
  };

  let http: Client | undefined;
  try {
    const connected = await connectHttp(
      new URL(`http://127.0.0.1:${port}/mcp`),
      statusRecorder(statuses),
      () => child.exitCode !== null,
      () => logs
    );
    http = connected;

    assert.match(
      connected.getNegotiatedProtocolVersion() ?? "",
      /^\d{4}-\d{2}-\d{2}$/,
      "initialize should negotiate a protocol version"
    );
    assert.equal(connected.getServerVersion()?.name, "sqlite-mcp-server", "unexpected serverInfo.name");
    assert.ok(connected.getServerCapabilities()?.tools, "the server should advertise the tools capability");

    const call = await connected.callTool({
      name: "sqlite_list_tables",
      arguments: { response_format: "json" }
    });
    // A successful tool result carries no isError flag at all, only a failing one does.
    assert.ok(!call.isError, `list_tables failed over HTTP: ${text(call)}`);
    const result = call.structuredContent as { total: number; objects: { name: string }[] } | undefined;
    assert.equal(result?.total, 5, "the HTTP run should see the demo schema");
    const names = (result?.objects ?? []).map((object) => object.name);
    assert.ok(names.includes("books") && names.includes("sales_by_book"), `missing objects: ${names.join(", ")}`);

    // initialize and tools/call answer 200 on /mcp; the initialized notification answers 202.
    assert.ok(statuses.length >= 2, `expected at least two POSTs to /mcp, got ${statuses.length}`);
    assert.ok(
      statuses.every((status) => status >= 200 && status < 300),
      `unexpected statuses on /mcp: ${statuses.join(", ")}`
    );
    assert.equal(statuses.at(-1), 200, `tools/call should answer 200 on /mcp, got ${statuses.at(-1)}`);

    // The README claims createMcpExpressApp rejects a foreign Origin and a mismatched Host.
    const foreignOrigin = await rawPost(port, { host: `127.0.0.1:${port}`, origin: "http://evil.example" }, initializeBody);
    assert.equal(foreignOrigin.status, 403, `a foreign Origin should be refused, got ${foreignOrigin.status}`);
    assert.match(foreignOrigin.body, /"Invalid Origin: evil\.example"/, `unexpected refusal: ${foreignOrigin.body.slice(0, 200)}`);

    // The control for the check above: the hostname is compared alone, so every loopback
    // spelling is accepted whatever the port, and a 403 there would mean "not local" rather
    // than "any Origin at all".
    const loopbackOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
      "http://127.0.0.1:9999" // a different port than the one the server listens on
    ];
    for (const origin of loopbackOrigins) {
      const localOrigin = await rawPost(port, { host: `127.0.0.1:${port}`, origin }, initializeBody);
      assert.equal(
        localOrigin.status,
        200,
        `Origin ${origin} should be accepted, got ${localOrigin.status}: ${localOrigin.body.slice(0, 200)}`
      );
      assert.match(localOrigin.body, /"protocolVersion"/, `unexpected reply for ${origin}: ${localOrigin.body.slice(0, 200)}`);
    }

    const foreignHost = await rawPost(port, { host: `evil.example:${port}` }, initializeBody);
    assert.equal(foreignHost.status, 403, `a mismatched Host should be refused, got ${foreignHost.status}`);
    assert.match(foreignHost.body, /"Invalid Host: evil\.example"/, `unexpected refusal: ${foreignHost.body.slice(0, 200)}`);
  } finally {
    if (http) await http.close().catch(() => {});
    child.kill();
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

/**
 * Starts the server against a database path that does not exist: reportDatabase must explain the
 * problem and keep serving, so tools return that error instead of the process dying.
 */
async function smokeMissingDatabase(): Promise<void> {
  const missingDb = join(mkdtempSync(join(tmpdir(), "sqlite-mcp-missing-")), "absent.db");
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...getDefaultEnvironment(),
      // Forwarded by hand for the same reason as the HTTP child: getDefaultEnvironment drops it.
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      SQLITE_DB_PATH: missingDb
    },
    stdio: ["pipe", "ignore", "pipe"]
  });
  let logs = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    logs += chunk;
  });

  const deadline = Date.now() + 10_000;
  while (!logs.includes("No SQLite database at")) {
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`the server never reported the missing database:\n${logs.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    assert.match(logs, /No SQLite database at .*absent\.db/, `unexpected startup message: ${logs.trim()}`);
    assert.match(logs, /bun run seed/, "the message should name the fix");
  } finally {
    // Closing stdin is how a stdio host stops the server; it also lets it exit normally.
    child.stdin?.end();
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (child.exitCode === null) child.kill();
    rmSync(dirname(missingDb), { recursive: true, force: true });
  }

  assert.equal(child.exitCode, 0, `the server should exit cleanly, got ${child.exitCode}: ${logs.trim()}`);
}

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), SQLITE_DB_PATH: testDb }
    })
  );

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["sqlite_describe_table", "sqlite_execute", "sqlite_insert_row", "sqlite_list_tables", "sqlite_query"],
    "unexpected tool list"
  );
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a description`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
  }

  // List tables
  const tables = await client.callTool({
    name: "sqlite_list_tables",
    arguments: { response_format: "json" }
  });
  assert.ok(!tables.isError, `list_tables failed: ${text(tables)}`);
  const tablePayload = tables.structuredContent as { objects: { name: string; row_count: number }[]; total: number };
  const names = tablePayload.objects.map((object) => object.name);
  assert.ok(names.includes("books") && names.includes("orders"), `missing tables: ${names.join(", ")}`);

  // Describe a table
  const describe = await client.callTool({
    name: "sqlite_describe_table",
    arguments: { table: "books", response_format: "json" }
  });
  assert.ok(!describe.isError, `describe_table failed: ${text(describe)}`);
  const described = describe.structuredContent as {
    columns: { name: string; primary_key: boolean }[];
    foreign_keys: { column: string }[];
  };
  assert.ok(described.columns.some((column) => column.name === "title"));
  assert.ok(described.columns.some((column) => column.primary_key));
  assert.ok(described.foreign_keys.some((key) => key.column === "author_id"), "books should expose its author FK");

  // Read with a named parameter
  const query = await client.callTool({
    name: "sqlite_query",
    arguments: {
      sql: "SELECT title, price FROM books WHERE author_id = $author_id ORDER BY published",
      params: { author_id: 1 },
      response_format: "json"
    }
  });
  assert.ok(!query.isError, `query failed: ${text(query)}`);
  const queryPage = query.structuredContent as { rows: { title: string }[]; count: number };
  assert.equal(queryPage.count, 4, `author 1 should have 4 books, got ${queryPage.count}`);
  assert.ok(queryPage.rows.some((row) => row.title === "The Dispossessed"));

  // Markdown mode must return text, not structured content
  const markdown = await client.callTool({ name: "sqlite_query", arguments: { sql: "SELECT * FROM authors" } });
  assert.ok(!markdown.isError, `markdown query failed: ${text(markdown)}`);
  assert.ok(text(markdown).includes("| name |"), "markdown output should contain a table header");
  assert.equal(markdown.structuredContent, undefined, "markdown mode should not return structured content");

  // A semicolon inside a literal is data, and a single trailing semicolon is allowed
  const literal = await client.callTool({
    name: "sqlite_query",
    arguments: { sql: "SELECT 'a;b' AS v;", response_format: "json" }
  });
  assert.ok(!literal.isError, `semicolon inside a literal failed: ${text(literal)}`);
  assert.equal((literal.structuredContent as { rows: { v: string }[] }).rows[0]?.v, "a;b");

  // Writes: insert, then update through sqlite_execute
  const insert = await client.callTool({
    name: "sqlite_insert_row",
    arguments: { table: "books", values: { title: "Smoke Test Book", author_id: 6, genre: "fiction", published: 2026, price: 1.5, stock: 1 } }
  });
  assert.ok(!insert.isError, `insert_row failed: ${text(insert)}`);
  const inserted = insert.structuredContent as { inserted: { id: number; title: string } };
  assert.equal(inserted.inserted.title, "Smoke Test Book");
  assert.ok(inserted.inserted.id > 22);

  const update = await client.callTool({
    name: "sqlite_execute",
    arguments: { sql: "UPDATE books SET stock = stock + 4 WHERE id = $id", params: { id: inserted.inserted.id } }
  });
  assert.ok(!update.isError, `execute failed: ${text(update)}`);
  assert.equal((update.structuredContent as { changes: number }).changes, 1);

  const verified = await client.callTool({
    name: "sqlite_query",
    arguments: { sql: "SELECT stock FROM books WHERE id = $id", params: { id: inserted.inserted.id }, response_format: "json" }
  });
  const stock = (verified.structuredContent as { rows: { stock: number }[] }).rows[0]?.stock;
  assert.equal(stock, 5, `expected stock 5 after update, got ${stock}`);

  // The read tool must refuse writes and report SQLite errors as tool errors
  const refused = await client.callTool({ name: "sqlite_query", arguments: { sql: "DELETE FROM books" } });
  assert.equal(refused.isError, true, "sqlite_query should refuse DELETE");

  const multiple = await client.callTool({
    name: "sqlite_query",
    arguments: { sql: "SELECT 1; SELECT 2" }
  });
  assert.equal(multiple.isError, true, "multiple statements should be refused");

  const missing = await client.callTool({ name: "sqlite_query", arguments: { sql: "SELECT * FROM missing_table" } });
  assert.equal(missing.isError, true, "unknown table should be a tool error");
  assert.ok(text(missing).includes("books"), "error should name the available tables");

  const badInsert = await client.callTool({
    name: "sqlite_insert_row",
    arguments: { table: "books", values: { titel: "Typo" } }
  });
  assert.equal(badInsert.isError, true, "unknown column should be a tool error");

  const invalidArgs = await client.callTool({ name: "sqlite_query", arguments: { sql: "" } });
  assert.equal(invalidArgs.isError, true, "empty SQL should be rejected by the schema");

  // Markdown is the default format, so these are the paths a host gets when it passes no format.
  const markdownTables = await client.callTool({ name: "sqlite_list_tables", arguments: {} });
  assert.ok(!markdownTables.isError, `markdown list_tables failed: ${text(markdownTables)}`);
  assert.match(text(markdownTables), /# Objects in .+/, "markdown list should have a heading");
  assert.match(text(markdownTables), /- \*\*books\*\* — table, \d+ row\(s\), \d+ column\(s\)/);
  assert.match(text(markdownTables), /Showing \d+ of \d+, starting at offset 0\./);
  assert.equal(markdownTables.structuredContent, undefined, "markdown mode should omit structured content");

  const markdownDescribe = await client.callTool({ name: "sqlite_describe_table", arguments: { table: "books" } });
  assert.ok(!markdownDescribe.isError, `markdown describe_table failed: ${text(markdownDescribe)}`);
  for (const expected of ["# books (table)", "**Foreign keys:**", "**Indexes:**", "## DDL", "CREATE TABLE books"]) {
    assert.ok(text(markdownDescribe).includes(expected), `markdown describe should contain ${expected}`);
  }

  // A markdown query with no rows takes the empty-page branch, which has its own message.
  const markdownEmpty = await client.callTool({
    name: "sqlite_query",
    arguments: { sql: "SELECT title FROM books WHERE author_id = $author_id", params: { author_id: 999 } }
  });
  assert.ok(!markdownEmpty.isError, `markdown empty query failed: ${text(markdownEmpty)}`);
  assert.ok(text(markdownEmpty).includes("The query returned no rows"), `unexpected empty page: ${text(markdownEmpty)}`);
  assert.ok(text(markdownEmpty).includes("Columns: title."), "the empty page should name the columns");

  // Schema resource
  const schema = await client.readResource({ uri: "sqlite://schema" });
  const schemaText = (schema.contents[0] as { text?: string }).text ?? "";
  assert.ok(schemaText.includes("CREATE TABLE books"), "schema resource should include the DDL");

  await smokeHttp(testDb);
  await smokeMissingDatabase();

  console.error("Smoke test passed");
} finally {
  await client.close();
  rmSync(workDir, { recursive: true, force: true });
}
