#!/usr/bin/env node
/**
 * sqlite-mcp-server
 *
 * Serves stdio by default (for Claude Desktop, Cursor, VS Code and other hosts that
 * launch the server as a subprocess), or Streamable HTTP when TRANSPORT=http.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME } from "./constants.js";
import { closeDb, databasePath, listObjects } from "./db.js";
import { createServer } from "./server.js";

function reportDatabase(): void {
  const path = databasePath();
  try {
    const objects = listObjects();
    console.error(
      `${SERVER_NAME}: using ${path} (${objects.length} table(s)/view(s): ${objects.map((object) => object.name).join(", ")})`
    );
  } catch (error) {
    console.error(
      `${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)} Tools will return this error until the database exists.`
    );
  }
}

reportDatabase();

if (process.env.TRANSPORT === "http") {
  const port = Number(process.env.PORT ?? 3000);
  const handler = createMcpHandler(createServer);
  const app = createMcpExpressApp(); // loopback only, with Host/Origin validation
  const nodeHandler = toNodeHandler(handler);

  app.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

  const server = app.listen(port, "127.0.0.1", () => {
    console.error(`${SERVER_NAME} listening on http://127.0.0.1:${port}/mcp`);
  });

  // Supervisors stop the server with a signal, and a normal exit is also what lets
  // NODE_V8_COVERAGE write its dump. Keep-alive sockets from MCP clients would hold
  // server.close() open indefinitely, so they are dropped instead of awaited.
  const shutdown = (signal: NodeJS.Signals) => {
    console.error(`${SERVER_NAME}: ${signal} received, shutting down`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} else {
  serveStdio(createServer);
  console.error(`${SERVER_NAME} running on stdio`);
}

// Throwaway branch: dead lines used to prove the end-to-end floor fails when it is missed.
export function coverageProbe(flags: boolean[]): number {
  let total = 0;
  if (flags[0]) total += 1;
  if (flags[1]) total += 2;
  if (flags[2]) total += 3;
  if (flags[3]) total += 4;
  if (flags[4]) total += 5;
  if (flags[5]) total += 6;
  if (flags[6]) total += 7;
  if (flags[7]) total += 8;
  if (flags[8]) total += 9;
  if (flags[9]) total += 10;
  if (flags[10]) total += 11;
  if (flags[11]) total += 12;
  return total;
}
