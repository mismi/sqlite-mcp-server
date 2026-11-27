/** Read-only tools: list tables, describe a table, run a SELECT. */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ResponseFormat } from "../constants.js";
import {
  countRows,
  databasePath,
  listObjects,
  resolveTable,
  runReadOnlyQuery,
  tableColumns,
  tableDdl,
  tableForeignKeys,
  tableIndexes
} from "../db.js";
import { fitToLimit, markdownTable, serializeRow } from "../format.js";

const responseFormatSchema = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable text, 'json' for structured data");

const paramsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .default({})
  .describe(
    'Values for named placeholders, keyed without the "$": SELECT * FROM books WHERE author_id = $author_id -> {"author_id": 1}'
  );

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerReadTools(server: McpServer): void {
  registerListTables(server);
  registerDescribeTable(server);
  registerQuery(server);
}

function registerListTables(server: McpServer): void {
  server.registerTool(
    "sqlite_list_tables",
    {
      title: "List Tables",
      description: `List the tables and views in the connected SQLite database, with row and column counts.

Start here when you do not know the schema, then use sqlite_describe_table for columns and keys and sqlite_query to read rows.

Returns one page at a time; when more exist, the result includes next_offset to pass back as offset.
Example: "What data is in this database?" -> no arguments.`,
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum objects to return"),
        offset: z.number().int().min(0).default(0).describe("Number of objects to skip, for pagination"),
        response_format: responseFormatSchema
      }),
      annotations: readAnnotations
    },
    async ({ limit, offset, response_format }) => {
      const database = databasePath();
      const objects = listObjects();
      const total = objects.length;
      const page = objects
        .slice(offset, offset + limit)
        .map((object) => ({
          name: object.name,
          type: object.type,
          row_count: countRows(object.name),
          column_count: tableColumns(object.name).length
        }));

      const build = (objects: typeof page) => {
        const nextOffset = offset + objects.length;
        const hasMore = total > nextOffset;
        const payload = {
          database,
          total,
          count: objects.length,
          offset,
          objects,
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {})
        };
        if (response_format === ResponseFormat.JSON) return { payload, text: JSON.stringify(payload, null, 2) };
        const lines = [`# Objects in ${database}`, ""];
        for (const object of objects) {
          lines.push(`- **${object.name}** — ${object.type}, ${object.row_count} row(s), ${object.column_count} column(s)`);
        }
        if (objects.length === 0) lines.push("- (none)");
        lines.push(
          "",
          `Showing ${objects.length} of ${total}, starting at offset ${offset}.${
            hasMore ? ` More results: call again with offset=${nextOffset}.` : ""
          }`
        );
        return { payload, text: lines.join("\n") };
      };

      const kept = fitToLimit(page, (objects) => build(objects).text);
      const { payload, text } = build(kept);
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text }], structuredContent: payload };
      }
      return { content: [{ type: "text", text }] };
    }
  );
}

function registerDescribeTable(server: McpServer): void {
  server.registerTool(
    "sqlite_describe_table",
    {
      title: "Describe Table",
      description: `Describe one table or view: columns and types, primary key, foreign keys, indexes, and the CREATE statement.

Use this before writing a query or an insert so column names, types and keys are correct. To find table names, call sqlite_list_tables.
Example: {"table": "books"} -> every column of books plus its foreign keys.`,
      inputSchema: z.strictObject({
        table: z.string().min(1).max(200).describe("Table or view name, e.g. 'books'"),
        response_format: responseFormatSchema
      }),
      annotations: readAnnotations
    },
    async ({ table, response_format }) => {
      const object = resolveTable(table);
      const columns = tableColumns(object.name);
      const foreignKeys = tableForeignKeys(object.name);
      const indexes = tableIndexes(object.name);
      const ddl = tableDdl(object.name);
      const payload = {
        table: object.name,
        type: object.type,
        row_count: countRows(object.name),
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type || "ANY",
          nullable: !column.notnull,
          default: column.default_value,
          primary_key: column.primary_key
        })),
        foreign_keys: foreignKeys,
        indexes,
        ddl
      };

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
      }

      const lines = [
        `# ${payload.table} (${payload.type})`,
        "",
        `${payload.row_count} row(s), ${columns.length} column(s).`,
        "",
        markdownTable(
          ["Column", "Type", "Nullable", "Default", "Primary key"],
          columns.map((column) => ({
            Column: column.name,
            Type: column.type || "ANY",
            Nullable: column.notnull ? "no" : "yes",
            Default: column.default_value ?? "",
            "Primary key": column.primary_key ? "yes" : ""
          }))
        )
      ];
      if (foreignKeys.length > 0) {
        lines.push("", "**Foreign keys:**");
        for (const key of foreignKeys) {
          lines.push(`- ${key.column} -> ${key.references_table}(${key.references_column}) on delete ${key.on_delete}`);
        }
      }
      if (indexes.length > 0) {
        lines.push("", "**Indexes:**");
        for (const index of indexes) {
          lines.push(`- ${index.name}${index.unique ? " (unique)" : ""}: ${index.columns.join(", ")}`);
        }
      }
      lines.push("", "## DDL", "```sql", ddl, "```");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

function registerQuery(server: McpServer): void {
  server.registerTool(
    "sqlite_query",
    {
      title: "Query Rows",
      description: `Run one read-only SQL statement (SELECT or WITH) against the SQLite database.

Results are paged at the SQL level: pass limit/offset rather than writing your own LIMIT when you need to page through many rows. Use named placeholders ($name) and params for values instead of interpolating them into the SQL.

Examples:
  - "How many books are there?" -> SELECT COUNT(*) AS books FROM books
  - "Books by author 3" -> sql: SELECT title FROM books WHERE author_id = $author_id, params: {"author_id": 3}
  - "Top 5 orders" -> sql: SELECT * FROM orders ORDER BY total DESC LIMIT 5

SQLite errors come back as tool errors naming the available tables or columns. This tool cannot modify data; use sqlite_execute or sqlite_insert_row for that.`,
      inputSchema: z.strictObject({
        sql: z
          .string()
          .min(1)
          .max(20_000)
          .describe("A single SELECT or WITH statement. Named placeholders look like $author_id."),
        params: paramsSchema,
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum rows to return"),
        offset: z.number().int().min(0).default(0).describe("Number of rows to skip, for pagination"),
        response_format: responseFormatSchema
      }),
      annotations: readAnnotations
    },
    async ({ sql, params, limit, offset, response_format }) => {
      const { columns, rows, has_more } = runReadOnlyQuery(sql, params, limit, offset);
      const serialized = rows.map(serializeRow);

      const build = (items: typeof serialized) => {
        const nextOffset = offset + items.length;
        const more = has_more || items.length < serialized.length;
        const payload = {
          columns,
          rows: items,
          count: items.length,
          offset,
          has_more: more,
          ...(more ? { next_offset: nextOffset } : {})
        };
        if (response_format === ResponseFormat.JSON) return { payload, text: JSON.stringify(payload, null, 2) };
        if (items.length === 0) {
          return {
            payload,
            text: [
              "# Query results",
              "",
              "The query returned no rows. Check the filters, or call sqlite_list_tables to confirm the table has data.",
              ``,
              `Columns: ${columns.join(", ")}.`
            ].join("\n")
          };
        }
        const lines = [`# Query results`, "", `Returned ${items.length} row(s) starting at offset ${offset}.`, ""];
        lines.push(markdownTable(columns, items));
        if (more) lines.push("", `More rows: call again with offset=${nextOffset}.`);
        return { payload, text: lines.join("\n") };
      };

      const kept = fitToLimit(serialized, (items) => build(items).text);
      const { payload, text } = build(kept);
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text }], structuredContent: payload };
      }
      return { content: [{ type: "text", text }] };
    }
  );
}
