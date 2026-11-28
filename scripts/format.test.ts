/**
 * Unit tests for src/format.ts: values SQLite can hand back that JSON cannot carry unchanged.
 * These run below the tool layer because node:sqlite only returns bigints when the connection
 * asks for them, so a normal query cannot reach that branch.
 *
 * Run with: bun run test
 */
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { markdownTable, serializeRow, serializeValue } from "../src/format.js";

test("serializeValue keeps safe integers as numbers, whatever their JavaScript type", () => {
  expect(serializeValue(42n)).toBe(42);
  expect(serializeValue(-42n)).toBe(-42);
  expect(serializeValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
});

test("serializeValue turns too-large bigints into strings instead of losing precision", () => {
  const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

  expect(serializeValue(tooLarge)).toBe("9007199254740993");
});

test("serializeValue replaces blobs with their size, and keeps null", () => {
  expect(serializeValue(new Uint8Array([1, 2, 3]))).toBe("<blob 3 bytes>");
  expect(serializeValue(null)).toBeNull();
  expect(serializeValue(undefined)).toBeNull();
});

test("markdownTable escapes a trailing backslash so it cannot swallow the cell separator", () => {
  const table = markdownTable(["path"], [{ path: "C:\\temp\\" }]);

  expect(table.split("\n")[2]).toBe("| C:\\\\temp\\\\ |");
});

test("serializeRow applies the same conversion to every column", () => {
  expect(serializeRow({ id: 1, big: 2n, blob: new Uint8Array(2) })).toEqual({
    id: 1,
    big: 2,
    blob: "<blob 2 bytes>"
  });
});
