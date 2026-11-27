# Security policy

## Supported versions

There are no tagged releases yet: fixes land on `main`, which is the only branch that receives them.
The supported runtimes are Node.js 22.16+ and Bun 1.2+.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
<https://github.com/mismi/sqlite-mcp-server/security/advisories/new>. Please do not open a public
issue for a security problem.

A useful report names the commit you tested, the exact tool call or HTTP request, what happens, and
what you expected instead. A reproduction against the demo database (`bun run seed`) is ideal,
because it removes everything specific to your own database.

## Scope

In scope:

- a way to make `sqlite_query` write, or to reach a statement outside `SELECT`/`WITH`/`VALUES`
  through SQL the guard accepts (comments, CTEs, `PRAGMA`, `ATTACH`, multiple statements);
- a way to reach files outside the database, or to execute SQL that the schema validation should
  have rejected as an identifier;
- a way past the HTTP transport's `Host`/`Origin` checks (DNS rebinding), or a request that reaches
  `/mcp` with a hostname other than `127.0.0.1`, `localhost` or `[::1]`;
- credentials or tokens committed to the repository, or written to logs.

Out of scope, by design:

- `sqlite_execute` running `INSERT`/`UPDATE`/`DELETE`/DDL: that is the tool's purpose, and the hints
  say so;
- the lack of authentication on `/mcp`. The server binds `127.0.0.1` only and authenticates
  nothing; exposing it to a network requires a reverse proxy that adds authentication;
- denial of service from a query you chose to run against your own database;
- the demo data in `data/demo.db`, which is public sample content.

## Secrets

The server itself needs no credentials. The optional model-driven evaluations read `EVAL_API_KEY`
and `EVAL_MODEL` from the environment only, never write them to disk and never log them. The
repository holds no environment files, and secret scanning with push protection is enabled on it, so
a token accidentally added to a commit is blocked before it reaches the branch.
