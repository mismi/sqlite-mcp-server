/**
 * Table tests for the SQL guards in src/db.ts: statement splitting, comment stripping,
 * parameter binding and the column validation of sqlite_insert_row.
 *
 * Every case is a row in a table below, so a broken guard shows up as one failing row
 * instead of one long assertion block. The database cases run against a throwaway copy of
 * the demo database, so data/demo.db is never written.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DB_PATH } from "../src/constants.js";
import {
  bindParams,
  closeDb,
  db,
  firstStatementEnd,
  insertRow,
  runReadOnlyQuery,
  runWriteStatement,
  singleStatement,
  stripComments
} from "../src/db.js";

const workDir = mkdtempSync(join(tmpdir(), "sqlite-mcp-db-test-"));
const testDb = join(workDir, "demo.db");
copyFileSync(DEFAULT_DB_PATH, testDb);
process.env.SQLITE_DB_PATH = testDb;

afterAll(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// firstStatementEnd: where the statement stops
// ---------------------------------------------------------------------------

const statementEnds: { name: string; sql: string; end: number }[] = [
  { name: "no semicolon", sql: "SELECT 1", end: 8 },
  { name: "plain semicolon", sql: "SELECT 1; SELECT 2", end: 8 },
  { name: "semicolon inside a literal", sql: "SELECT 'a;b'", end: 12 },
  { name: "escaped quotes inside a literal", sql: "SELECT 'it''s;'", end: 15 },
  { name: "semicolon inside a quoted identifier", sql: 'SELECT ";" FROM t', end: 17 },
  { name: "semicolon inside a line comment", sql: "SELECT 1 -- x;\nSELECT 2", end: 23 },
  { name: "semicolon after a block comment", sql: "SELECT 1 /* a;b */; SELECT 2", end: 18 },
  { name: "unterminated block comment", sql: "SELECT 1 /* a;b", end: 15 }
];

for (const { name, sql, end } of statementEnds) {
  test(`firstStatementEnd: ${name}`, () => {
    expect(firstStatementEnd(sql)).toBe(end);
  });
}

// ---------------------------------------------------------------------------
// stripComments: the tail that may follow a statement
// ---------------------------------------------------------------------------

const strippedTails: { name: string; tail: string; expected: string }[] = [
  { name: "line comment", tail: " -- trailing note", expected: " " },
  { name: "several line comments", tail: "\n-- a;b\n-- c", expected: "\n\n" },
  { name: "block comment", tail: " /* a;b */ ", expected: "  " },
  { name: "multi-line block comment", tail: " /* a;\nb */", expected: " " },
  { name: "no comment", tail: " ; ", expected: " ; " }
];

for (const { name, tail, expected } of strippedTails) {
  test(`stripComments: ${name}`, () => {
    expect(stripComments(tail)).toBe(expected);
  });
}

// ---------------------------------------------------------------------------
// singleStatement: what survives, and what is refused
// ---------------------------------------------------------------------------

const accepted: { name: string; context: "read" | "write"; input: string; expected: string }[] = [
  { name: "plain read", context: "read", input: "SELECT 1", expected: "SELECT 1" },
  { name: "trailing semicolon", context: "read", input: "SELECT 1;", expected: "SELECT 1" },
  { name: "surrounding whitespace", context: "read", input: "  SELECT 1 ;  ", expected: "SELECT 1" },
  { name: "repeated trailing semicolons", context: "read", input: "SELECT 1;;", expected: "SELECT 1" },
  { name: "trailing line comment", context: "read", input: "SELECT 1; -- trailing note", expected: "SELECT 1" },
  { name: "trailing block comment", context: "read", input: "SELECT 1; /* note; */ ;", expected: "SELECT 1" },
  { name: "semicolon inside a literal", context: "read", input: "SELECT 'a;b' AS v", expected: "SELECT 'a;b' AS v" },
  { name: "escaped quotes before a semicolon", context: "read", input: "SELECT 'it''s;' AS v", expected: "SELECT 'it''s;' AS v" },
  { name: "semicolon inside a quoted identifier", context: "read", input: 'SELECT "a;b" FROM t', expected: 'SELECT "a;b" FROM t' },
  { name: "semicolon inside a leading comment", context: "read", input: "/* lead; */ SELECT 1", expected: "/* lead; */ SELECT 1" },
  { name: "statement ending in a line comment", context: "read", input: "SELECT 1 -- note; SELECT 2", expected: "SELECT 1 -- note; SELECT 2" },
  { name: "WITH query", context: "read", input: "WITH x(v) AS (VALUES (1)) SELECT * FROM x", expected: "WITH x(v) AS (VALUES (1)) SELECT * FROM x" },
  { name: "VALUES query", context: "read", input: "VALUES (1), (2)", expected: "VALUES (1), (2)" },
  { name: "UPDATE with a trailing semicolon", context: "write", input: "UPDATE books SET stock = 1 WHERE id = 1;", expected: "UPDATE books SET stock = 1 WHERE id = 1" },
  { name: "DELETE with a trailing comment", context: "write", input: "DELETE FROM orders WHERE id = 1; -- cleanup", expected: "DELETE FROM orders WHERE id = 1" }
];

for (const { name, context, input, expected } of accepted) {
  test(`singleStatement accepts: ${name}`, () => {
    expect(singleStatement(input, context)).toBe(expected);
  });
}

const refused: { name: string; context: "read" | "write"; input: string; message: RegExp }[] = [
  { name: "empty input", context: "read", input: "", message: /No SQL statement/ },
  { name: "whitespace only", context: "read", input: "   ", message: /No SQL statement/ },
  { name: "second statement", context: "read", input: "SELECT 1; SELECT 2", message: /Only one SQL statement/ },
  { name: "second statement on a write", context: "write", input: "UPDATE books SET stock = 1; DELETE FROM books", message: /Only one SQL statement/ },
  { name: "second statement after a line comment", context: "read", input: "SELECT 1 -- one;\n; SELECT 2", message: /Only one SQL statement/ },
  { name: "write sent to the read tool", context: "read", input: "DELETE FROM books", message: /read-only queries.*"DELETE"/ },
  { name: "PRAGMA sent to the read tool", context: "read", input: "PRAGMA table_info(books)", message: /read-only queries.*"PRAGMA"/ },
  { name: "read sent to the write tool", context: "write", input: "SELECT 1", message: /does not run "SELECT"/ },
  { name: "WITH sent to the write tool", context: "write", input: "WITH x AS (SELECT 1) SELECT * FROM x", message: /does not run "WITH"/ },
  { name: "ATTACH sent to the write tool", context: "write", input: "ATTACH DATABASE 'other.db' AS other", message: /does not run "ATTACH"/ }
];

for (const { name, context, input, message } of refused) {
  test(`singleStatement refuses: ${name}`, () => {
    expect(() => singleStatement(input, context)).toThrow(message);
  });
}

// ---------------------------------------------------------------------------
// bindParams: tool arguments to SQLite bindings
// ---------------------------------------------------------------------------

const bindings: { name: string; params: Record<string, string | number | boolean | null> | undefined; expected: Record<string, string | number | null> }[] = [
  { name: "no params", params: undefined, expected: {} },
  { name: "empty params", params: {}, expected: {} },
  { name: "numbers and strings", params: { author_id: 1, title: "Dune", price: 12.5 }, expected: { author_id: 1, title: "Dune", price: 12.5 } },
  { name: "booleans become integers", params: { active: true, archived: false }, expected: { active: 1, archived: 0 } },
  { name: "null is kept", params: { note: null }, expected: { note: null } }
];

for (const { name, params, expected } of bindings) {
  test(`bindParams: ${name}`, () => {
    expect(bindParams(params)).toEqual(expected);
  });
}

// ---------------------------------------------------------------------------
// insertRow: table resolution and column validation
// ---------------------------------------------------------------------------

test("insertRow refuses an unknown column and lists the real ones", () => {
  expect(() => insertRow("books", { titel: "Typo" })).toThrow(
    /Unknown column\(s\) on "books": titel\. Available columns: id, title, author_id/
  );
});

test("insertRow resolves the table name before validating columns", () => {
  expect(() => insertRow("BOOKS", { titel: "Typo" })).toThrow(/on "books": titel/);
});

test("insertRow refuses an unknown table and lists the available objects", () => {
  expect(() => insertRow("nope", { title: "Dune" })).toThrow(/No table or view named "nope"\. Available objects: .*books/);
});

test("insertRow refuses an empty values object", () => {
  expect(() => insertRow("books", {})).toThrow(/at least one column/);
});

test("insertRow accepts known columns and returns the stored row", () => {
  const row = insertRow("books", {
    title: "Table Test Book",
    author_id: 1,
    genre: "fiction",
    published: 2026,
    price: 1.5,
    stock: 1
  });
  expect(row?.title).toBe("Table Test Book");
  // The connection reads INTEGERs as bigints; the tools convert them for JSON.
  expect(Number(row?.stock)).toBe(1);
  expect(Number(row?.id)).toBeGreaterThan(22);
});

// ---------------------------------------------------------------------------
// Error paths: the message a model has to act on
// ---------------------------------------------------------------------------

test("db() explains a missing database instead of creating one", () => {
  const previous = process.env.SQLITE_DB_PATH;
  closeDb();
  process.env.SQLITE_DB_PATH = join(workDir, "missing.db");
  try {
    expect(() => db()).toThrow(/No SQLite database at .*missing\.db/);
  } finally {
    process.env.SQLITE_DB_PATH = previous;
  }
});

test("runReadOnlyQuery names the available tables when one is missing", () => {
  expect(() => runReadOnlyQuery("SELECT * FROM missing_table", {}, 50, 0)).toThrow(
    /no such table: missing_table\. Available objects: .*books.*sqlite_list_tables/
  );
});

test("runReadOnlyQuery points at describe_table for an unknown column", () => {
  expect(() => runReadOnlyQuery("SELECT missing_column FROM books", {}, 50, 0)).toThrow(
    /no such column: missing_column.*sqlite_describe_table/
  );
});

test("runReadOnlyQuery falls back to the parameter hint for other errors", () => {
  expect(() => runReadOnlyQuery("SELECT 1 +", {}, 50, 0)).toThrow(/Check the SQL: named parameters look like \$author_id/);
});

test("insertRow explains a foreign key violation", () => {
  expect(() =>
    insertRow("books", { title: "Orphan", author_id: 999, genre: "fiction", published: 2026, price: 1, stock: 1 })
  ).toThrow(/FOREIGN KEY constraint failed.*referenced row does not exist/);
});

test("runWriteStatement explains a unique violation and a missing table", () => {
  db().exec("CREATE TABLE unique_probe (value TEXT UNIQUE)");
  runWriteStatement("INSERT INTO unique_probe (value) VALUES ('a')", {});

  expect(() => runWriteStatement("INSERT INTO unique_probe (value) VALUES ('a')", {})).toThrow(
    /UNIQUE constraint failed.*already exists/
  );
  expect(() => runWriteStatement("INSERT INTO missing_table (x) VALUES (1)", {})).toThrow(/no such table: missing_table/);
});
