/**
 * Builds the MCP server instance.
 *
 * Kept out of index.ts so tests can mount the real server (every tool and the schema
 * resource) on an in-memory transport without starting stdio or HTTP.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { databaseDdl } from "./db.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

/**
 * Builds a fresh server instance.
 *
 * `serveStdio` calls this once per connection and `createMcpHandler` calls it once per
 * HTTP request, so nothing is registered on a shared instance.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerReadTools(server);
  registerWriteTools(server);

  server.registerResource(
    "sqlite-schema",
    "sqlite://schema",
    {
      title: "Database schema",
      description: "CREATE statements for every table, view and index in the connected database",
      mimeType: "text/plain"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: databaseDdl() }]
    })
  );

  return server;
}
