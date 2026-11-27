# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-11-27

First release.

### Added

- Five MCP tools over one SQLite file: `sqlite_list_tables`, `sqlite_describe_table`,
  `sqlite_query`, `sqlite_insert_row` and `sqlite_execute`.
- Two transports: stdio for local hosts, and Streamable HTTP on `127.0.0.1:3000/mcp` with a
  `SIGTERM`/`SIGINT` shutdown that closes the database.
- Markdown by default and JSON on request (`response_format`), with `structuredContent` only in
  JSON mode; oversized pages are trimmed to the text limit and repaginated rather than truncated
  mid-row.
- SQL-level pagination (`limit`/`offset`, `next_offset`, `has_more`) instead of loading every row.
- Read-only guard on `sqlite_query` (single statement, `SELECT`/`WITH`/`VALUES` only) and a write
  guard on `sqlite_execute` that refuses `SELECT`, `WITH`, `VALUES`, `PRAGMA` and `ATTACH`.
- 64-bit `INTEGER` values read as bigints so they are not rounded through doubles, then serialised
  so JSON clients see exact values.
- `sqlite://schema` resource exposing the database DDL.
- `bun run seed` to create the demo database, plus deterministic evals (`bun run evals`) and an
  optional model-driven eval harness.

### Security

- `gitleaks` job scanning the whole git history on every pull request.
- CodeQL static analysis (`javascript-typescript`), dependency review on pull requests, and a
  weekly OpenSSF Scorecard run publishing SARIF to code scanning.
- Every action pinned to a 40-character commit SHA with its release in a `# vX.Y.Z` comment;
  Dependabot watches both ecosystems daily, grouped.
- The actionlint binary is downloaded from its release and its sha256 compared before it runs.
- Secret scanning with push protection, Dependabot alerts, and a `SECURITY.md`.
- Minimal token permissions per workflow; `contents: read` at the top level.

### Testing and CI

- Ten CI jobs: `actionlint`, `gitleaks`, and eight cells of four runtimes
  (`node-22.16`, `node-22.18`, `node-24`, `bun`) on Ubuntu and Windows.
- Unit coverage with per-file floors (`bunfig.toml` at 0.9 plus `scripts/check-coverage.ts`), and
  end-to-end coverage from V8 dumps merged by c8, gated per file on lines **and** branches.
- `coverage-unit` and `coverage-e2e` artefacts published on every run.

[Unreleased]: https://github.com/mismi/sqlite-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mismi/sqlite-mcp-server/releases/tag/v1.0.0
