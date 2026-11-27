/**
 * In-process tests for the Express layer: createMcpExpressApp is mounted exactly as
 * src/index.ts mounts it, on a loopback port, and driven with raw node:http requests so a
 * test can set a foreign Host or Origin the way a browser or a rebinding attack would.
 * Nothing is spawned, so these run fast and cover the options the smoke only exercises with
 * their defaults: allowedHosts, allowedOrigins, JSON parsing and non-POST methods.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp, type CreateMcpExpressAppOptions } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sqlite-mcp-http-test", version: "1.0.0" }
  }
};

interface Reply {
  status: number;
  contentType: string;
  body: string;
}

let app: { port: number; close: () => Promise<void> } | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Builds the same app src/index.ts does, but on port 0 and without any stdio side effect. */
async function startApp(options: CreateMcpExpressAppOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createMcpHandler(() => new McpServer({ name: "sqlite-mcp-http-test", version: "1.0.0" }));
  const nodeHandler = toNodeHandler(handler);
  const express = createMcpExpressApp(options);
  express.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

  const server = express.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** A request with the headers written as given; fetch() would overwrite Host and refuse it. */
function send(
  port: number,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        setHost: false,
        headers: { accept: "application/json, text/event-stream", ...headers }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          const contentType = res.headers["content-type"];
          resolve({
            status: res.statusCode ?? 0,
            contentType: Array.isArray(contentType) ? contentType.join(", ") : (contentType ?? ""),
            body: raw
          });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A real initialize request, so a 200 proves the endpoint answered and not just the middleware. */
function initialize(port: number, headers: Record<string, string>): Promise<Reply> {
  return send(port, "POST", { "content-type": "application/json", ...headers }, JSON.stringify(INITIALIZE));
}

function refusal(reply: Reply): { code: number; message: string } {
  const payload = JSON.parse(reply.body) as { jsonrpc: string; error: { code: number; message: string }; id: null };
  expect(payload.jsonrpc).toBe("2.0");
  expect(payload.id).toBeNull();
  return payload.error;
}

test("the defaults accept every loopback spelling of Host and Origin, whatever the port", async () => {
  app = await startApp();
  const port = app.port;

  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  // No Origin is a non-browser client; the others differ by hostname spelling and port only.
  const origins = [undefined, `http://127.0.0.1:${port + 1}`, "http://localhost:1234", `http://[::1]:${port}`];

  for (const host of hosts) {
    for (const origin of origins) {
      const reply = await initialize(port, origin ? { host, origin } : { host });
      expect(reply.status).toBe(200);
      expect(reply.body).toContain('"protocolVersion"');
    }
  }
});

test("a foreign Origin is refused with a JSON-RPC 403", async () => {
  app = await startApp();

  const reply = await initialize(app.port, { host: `127.0.0.1:${app.port}`, origin: "http://evil.example" });

  expect(reply.status).toBe(403);
  expect(reply.contentType).toContain("application/json");
  expect(refusal(reply).message).toBe("Invalid Origin: evil.example");
});

test("a mismatched Host is refused with a JSON-RPC 403", async () => {
  app = await startApp();

  const reply = await initialize(app.port, { host: "evil.example:1234" });

  expect(reply.status).toBe(403);
  expect(reply.contentType).toContain("application/json");
  expect(refusal(reply).message).toBe("Invalid Host: evil.example");
});

test("allowedHosts replaces the loopback defaults", async () => {
  app = await startApp({ allowedHosts: ["mcp.test"] });

  const allowed = await initialize(app.port, { host: `mcp.test:${app.port}` });
  expect(allowed.status).toBe(200);

  const loopback = await initialize(app.port, { host: `127.0.0.1:${app.port}` });
  expect(loopback.status).toBe(403);
  expect(refusal(loopback).message).toBe("Invalid Host: 127.0.0.1");
});

test("allowedOrigins replaces the loopback defaults and compares the hostname only", async () => {
  app = await startApp({ allowedOrigins: ["app.example"] });

  const allowed = await initialize(app.port, {
    host: `127.0.0.1:${app.port}`,
    origin: "https://app.example:8443"
  });
  expect(allowed.status).toBe(200);

  const refused = await initialize(app.port, {
    host: `127.0.0.1:${app.port}`,
    origin: "https://other.example"
  });
  expect(refused.status).toBe(403);
  expect(refusal(refused).message).toBe("Invalid Origin: other.example");
});

test("a request without Origin passes, as non-browser clients send none", async () => {
  app = await startApp();

  const reply = await initialize(app.port, { host: `127.0.0.1:${app.port}` });

  expect(reply.status).toBe(200);
  expect(reply.body).toContain('"serverInfo"');
});

test("a malformed JSON body is rejected before the MCP handler runs", async () => {
  app = await startApp();

  const reply = await send(
    app.port,
    "POST",
    { host: `127.0.0.1:${app.port}`, "content-type": "application/json" },
    "{"
  );

  expect(reply.status).toBe(400);
  // Express's body parser answered, so the request never reached JSON-RPC.
  expect(reply.body).not.toContain("protocolVersion");
});

test("GET and DELETE on /mcp are refused with 405, not 403", async () => {
  app = await startApp();
  const host = `127.0.0.1:${app.port}`;

  for (const method of ["GET", "DELETE"]) {
    const reply = await send(app.port, method, { host });
    // 405 rather than 403 proves the Host/Origin guard let the request through to the handler.
    expect(reply.status).toBe(405);
    expect(refusal(reply).message).toBe("Method not allowed.");
  }
});
