/** Shared configuration for the SQLite MCP server. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, both when running from src/ (bun) and from dist/ (built). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SERVER_NAME = "sqlite-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Default database used when SQLITE_DB_PATH is not set. */
export const DEFAULT_DB_PATH = resolve(PACKAGE_ROOT, "data", "demo.db");

/** Cap on the size of a tool's text response. */
export const CHARACTER_LIMIT = 25_000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}
