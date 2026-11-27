/**
 * SQLite access layer: one lazily opened connection, schema introspection, and the
 * read/write entry points used by the tools.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DEFAULT_DB_PATH } from "./constants.js";

export type Scalar = string | number | boolean | null;
export type Row = Record<string, unknown>;
type BindValue = string | number | null;

export function databasePath(): string {
  const configured = process.env.SQLITE_DB_PATH?.trim();
  return configured ? resolve(process.cwd(), configured) : DEFAULT_DB_PATH;
}

let connection: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (connection) return connection;
  const path = databasePath();
  if (!existsSync(path)) {
    throw new Error(
      `No SQLite database at ${path}. Set SQLITE_DB_PATH to the absolute path of a .db file, or run "bun run seed" to create the demo database.`
    );
  }
  // readBigInts keeps 64-bit INTEGER values exact: as doubles, anything above 2^53 is silently
  // rounded. serializeValue turns the safe ones back into numbers, so clients see the same
  // values as before except for integers JSON cannot represent.
  connection = new DatabaseSync(path, { readBigInts: true });
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  return connection;
}

/** Closes the connection; tests need it so the temp database copy can be deleted on Windows. */
export function closeDb(): void {
  connection?.close();
  connection = null;
}

// ---------------------------------------------------------------------------
// SQL guards
// ---------------------------------------------------------------------------

/**
 * Returns the single statement in `input`, trimmed, without its trailing semicolon.
 *
 * A second statement is rejected rather than ignored: SQLite stops parsing after the
 * first one, so `UPDATE ...; UPDATE ...` would otherwise report success for a batch
 * where only half ran.
 */
export function singleStatement(input: string, context: "read" | "write"): string {
  const sql = input.trim();
  const end = firstStatementEnd(sql);
  const statement = sql.slice(0, end).trim();
  if (statement.length === 0) {
    throw new Error('No SQL statement was provided. Pass it in the "sql" argument.');
  }
  // Only whitespace and further semicolons may follow: anything else is a second statement.
  if (stripComments(sql.slice(end)).replace(/[;\s]+/g, "").length > 0) {
    throw new Error(
      `Only one SQL statement can be sent per call. Send "${statement.slice(0, 80)}" and the other statements in separate calls.`
    );
  }
  const keyword = leadingKeyword(statement);
  if (context === "read" && !/^(SELECT|WITH|VALUES)$/.test(keyword)) {
    throw new Error(
      `This tool only runs read-only queries, but the statement starts with "${keyword || "?"}". Start it with SELECT or WITH, or use sqlite_execute to modify data.`
    );
  }
  if (context === "write" && /^(SELECT|WITH|VALUES|PRAGMA|ATTACH)$/.test(keyword)) {
    throw new Error(
      `sqlite_execute does not run "${keyword}" statements: reads belong in sqlite_query, and PRAGMA/ATTACH can change settings or reach other files.`
    );
  }
  return statement;
}

/** Index of the first semicolon outside string literals and comments. */
export function firstStatementEnd(sql: string): number {
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (quote) {
      if (char === quote) {
        if (sql[i + 1] === quote) i += 1; // '' and "" escape themselves
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      if (newline === -1) return sql.length;
      i = newline;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) return sql.length;
      i = close + 1;
      continue;
    }
    if (char === ";") return i;
  }
  return sql.length;
}

/** Drops comments so a trailing `-- note` is not mistaken for a second statement. */
export function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function leadingKeyword(statement: string): string {
  const withoutLeadingComments = statement.replace(/^\s*(\/\*[\s\S]*?\*\/|--[^\n]*)\s*/g, "");
  return /^[A-Za-z]+/.exec(withoutLeadingComments)?.[0].toUpperCase() ?? "";
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function toBindValue(value: Scalar): BindValue {
  return typeof value === "boolean" ? Number(value) : value;
}

export function bindParams(params: Record<string, Scalar> | undefined): Record<string, BindValue> {
  const bound: Record<string, BindValue> = {};
  for (const [key, value] of Object.entries(params ?? {})) bound[key] = toBindValue(value);
  return bound;
}

/** node:sqlite accepts bare parameter names (a `$name` placeholder bound by {name}) by default. */
function runAll(statement: StatementSync, params: Record<string, BindValue>): Row[] {
  const rows = Object.keys(params).length > 0 ? statement.all(params) : statement.all();
  return rows as unknown as Row[];
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export interface DbObject {
  name: string;
  type: "table" | "view";
}

export function listObjects(): DbObject[] {
  const rows = db()
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all() as { name: string; type: string }[];
  return rows.map((row) => ({ name: row.name, type: row.type === "view" ? "view" : "table" }));
}

/** Resolves a user-supplied table name to its real name, or throws with the valid names. */
export function resolveTable(name: string): DbObject {
  const wanted = name.trim();
  const objects = listObjects();
  const match =
    objects.find((object) => object.name === wanted) ??
    objects.find((object) => object.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const available = objects.map((object) => object.name).join(", ") || "(none)";
    throw new Error(`No table or view named "${wanted}". Available objects: ${available}.`);
  }
  return match;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  default_value: string | null;
  primary_key: boolean;
}

export function tableColumns(table: string): ColumnInfo[] {
  const rows = db()
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all() as { name: string; type: string | null; notnull: number; dflt_value: string | null; pk: number }[];
  return rows.map((row) => ({
    name: row.name,
    type: row.type ?? "",
    notnull: Number(row.notnull) === 1,
    default_value: row.dflt_value,
    primary_key: Number(row.pk) > 0
  }));
}

export interface ForeignKeyInfo {
  column: string;
  references_table: string;
  references_column: string;
  on_delete: string;
}

export function tableForeignKeys(table: string): ForeignKeyInfo[] {
  const rows = db()
    .prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
    .all() as { table: string; from: string; to: string | null; on_delete: string }[];
  return rows.map((row) => ({
    column: row.from,
    references_table: row.table,
    references_column: row.to ?? "",
    on_delete: row.on_delete
  }));
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

export function tableIndexes(table: string): IndexInfo[] {
  const indexes = db()
    .prepare(`PRAGMA index_list(${quoteIdent(table)})`)
    .all() as { name: string; unique: number }[];
  return indexes.map((index) => {
    const columns = db()
      .prepare(`PRAGMA index_info(${quoteIdent(index.name)})`)
      .all() as { name: string | null }[];
    return {
      name: index.name,
      unique: Number(index.unique) === 1,
      columns: columns.map((column) => column.name ?? "(expression)")
    };
  });
}

export function tableDdl(table: string): string {
  const row = db()
    .prepare(`SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? "";
}

export function countRows(table: string): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number };
  return Number(row.n);
}

/** Tables, then views, then indexes: the order in which the DDL can be replayed. */
export function databaseDdl(): string {
  const rows = db()
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`
    )
    .all() as { sql: string }[];
  return rows.map((row) => `${row.sql};`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

export interface QueryPage {
  columns: string[];
  rows: Row[];
  has_more: boolean;
}

/**
 * Runs a read-only query, paged at the SQL level: the statement is wrapped as a
 * subquery so LIMIT/OFFSET apply inside SQLite instead of loading every row.
 */
export function runReadOnlyQuery(
  rawSql: string,
  params: Record<string, Scalar> | undefined,
  limit: number,
  offset: number
): QueryPage {
  const sql = singleStatement(rawSql, "read");
  const wrapped = `SELECT * FROM (\n${sql}\n) LIMIT ${limit + 1} OFFSET ${offset}`;
  let prepared: StatementSync;
  let rows: Row[];
  try {
    prepared = db().prepare(wrapped);
    rows = runAll(prepared, bindParams(params));
  } catch (error) {
    throw queryError(error, sql);
  }
  const columns = prepared.columns().map((column) => column.name);
  const hasMore = rows.length > limit;
  return { columns, rows: hasMore ? rows.slice(0, limit) : rows, has_more: hasMore };
}

function queryError(error: unknown, sql: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table/i.test(message)) {
    const available = listObjects().map((object) => object.name).join(", ") || "(none)";
    return new Error(`${message}. Available objects: ${available}. Call sqlite_list_tables to see the schema.`);
  }
  if (/no such column/i.test(message)) {
    return new Error(`${message}. Call sqlite_describe_table on the table to see its columns.`);
  }
  return new Error(
    `${message}. Check the SQL: named parameters look like $author_id in the SQL with {"author_id": 1} in params. Query sent: ${sql.slice(0, 300)}`
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Inserts one row and returns it as SQLite stored it (defaults and generated keys included). */
export function insertRow(table: string, values: Record<string, Scalar>): Row | null {
  const target = resolveTable(table);
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new Error(`values must contain at least one column, e.g. {"title": "Dune"}.`);
  }
  const known = tableColumns(target.name).map((column) => column.name);
  const unknown = entries.map(([name]) => name).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown column(s) on "${target.name}": ${unknown.join(", ")}. Available columns: ${known.join(", ")}.`
    );
  }

  const bound: Record<string, BindValue> = {};
  entries.forEach(([, value], index) => {
    bound[`$v${index}`] = toBindValue(value);
  });
  const placeholders = entries.map((_, index) => `$v${index}`);
  const sql = `INSERT INTO ${quoteIdent(target.name)} (${entries
    .map(([name]) => quoteIdent(name))
    .join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;

  try {
    return runAll(db().prepare(sql), bound)[0] ?? null;
  } catch (error) {
    throw writeError(error);
  }
}

export interface WriteResult {
  changes: number;
  last_insert_rowid: number | null;
}

export function runWriteStatement(rawSql: string, params: Record<string, Scalar> | undefined): WriteResult {
  const sql = singleStatement(rawSql, "write");
  const bound = bindParams(params);
  try {
    const prepared = db().prepare(sql);
    const result = Object.keys(bound).length > 0 ? prepared.run(bound) : prepared.run();
    // lastInsertRowid is the connection's last insert, so an UPDATE or DELETE would otherwise
    // report an id from an earlier call; only an INSERT/REPLACE produced this rowid.
    const inserted = /^(INSERT|REPLACE)$/.test(leadingKeyword(sql));
    const rowid = Number(result.lastInsertRowid);
    return { changes: Number(result.changes), last_insert_rowid: inserted && rowid > 0 ? rowid : null };
  } catch (error) {
    throw writeError(error);
  }
}

function writeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new Error(`${message}. The referenced row does not exist; sqlite_describe_table shows foreign keys.`);
  }
  if (/UNIQUE constraint failed/i.test(message)) {
    return new Error(`${message}. A row with that unique value already exists.`);
  }
  return new Error(message);
}
