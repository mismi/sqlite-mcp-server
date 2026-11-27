/** Write tools: insert one row, or run one modifying statement. */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { insertRow, runWriteStatement } from "../db.js";
import { serializeRow } from "../format.js";

const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const paramsSchema = z
  .record(z.string(), valueSchema)
  .default({})
  .describe('Values for named placeholders, keyed without the "$", e.g. {"id": 5}');

export function registerWriteTools(server: McpServer): void {
  registerInsertRow(server);
  registerExecute(server);
}

function registerInsertRow(server: McpServer): void {
  server.registerTool(
    "sqlite_insert_row",
    {
      title: "Insert Row",
      description: `Insert one row into a table and return the row as SQLite stored it.

Prefer this over hand-written INSERT SQL: column names are validated against the table, so typos come back as a clear error. Omit auto-increment primary keys and let SQLite assign them.

Example: {"table": "books", "values": {"title": "Dune", "author_id": 3, "price": 9.99}} -> the inserted row with its new id.
Call sqlite_describe_table first when you are unsure of column names.`,
      inputSchema: z.strictObject({
        table: z.string().min(1).max(200).describe("Table to insert into"),
        values: z
          .record(z.string(), valueSchema)
          .describe('Column values keyed by column name, e.g. {"title": "Dune", "price": 9.99}')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ table, values }) => {
      const row = insertRow(table, values);
      const payload = { table, inserted: row ? serializeRow(row) : null };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }
  );
}

function registerExecute(server: McpServer): void {
  server.registerTool(
    "sqlite_execute",
    {
      title: "Execute Statement",
      description: `Run one modifying SQL statement: INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER or DROP.

Use this for updates, deletes and schema changes. For a single INSERT prefer sqlite_insert_row, which validates columns and returns the new row. For reads use sqlite_query.

One statement per call: a batch would be silently truncated by SQLite, so extra statements are rejected. Use named placeholders ($name) with params instead of interpolating values.

Example: {"sql": "UPDATE books SET stock = stock - $n WHERE id = $id", "params": {"n": 2, "id": 5}} -> {"changes": 1}.
A result of 0 changes means the WHERE clause matched nothing; call sqlite_query first to confirm the rows exist.`,
      inputSchema: z.strictObject({
        sql: z
          .string()
          .min(1)
          .max(20_000)
          .describe("One modifying or DDL statement. Named placeholders look like $id."),
        params: paramsSchema
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ sql, params }) => {
      const payload = runWriteStatement(sql, params);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }
  );
}
