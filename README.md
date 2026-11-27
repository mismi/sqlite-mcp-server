# sqlite-mcp-server

An MCP server for exploring and querying a local SQLite database. It gives an LLM five tools to
inspect and modify a `.db` file, and serves both stdio (local hosts) and Streamable HTTP.

Built with the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) and the built-in
`node:sqlite` module, so there are no native modules to compile.

## Tools

| Tool | What it does | Read-only |
|---|---|---|
| `sqlite_list_tables` | Lists tables and views with row and column counts | yes |
| `sqlite_describe_table` | Columns, types, primary key, foreign keys, indexes, DDL | yes |
| `sqlite_query` | Runs one `SELECT`/`WITH` statement, paged, with named parameters | yes |
| `sqlite_insert_row` | Inserts one row with validated column names, returns the stored row | no |
| `sqlite_execute` | Runs one `INSERT`/`UPDATE`/`DELETE`/DDL statement | no (destructive hint) |

Read tools accept `response_format` (`markdown` default, or `json` for `structuredContent`) and
`limit`/`offset` pagination. Query values are bound with named parameters — write `$author_id` in
the SQL and pass `{"author_id": 1}` — so values are never interpolated into SQL.

`sqlite_execute` returns `{changes, last_insert_rowid}`. `changes` counts the rows the statement
touched, so it is `0` for DDL and for an `UPDATE`/`DELETE` that matched nothing. `last_insert_rowid`
is filled only when the statement stored a row: `INSERT` and `REPLACE` return the id they wrote,
while `UPDATE`, `DELETE` and DDL return `null`. SQLite's `last_insert_rowid` belongs to the
connection, so without this rule an `UPDATE` would report the id of an earlier `INSERT`.

```json
{"sql": "INSERT INTO books (title, author_id, genre, published, price, stock) VALUES ($title, 1, 'fiction', 2026, 9.99, 1)", "params": {"title": "Dune"}}
-> {"changes": 1, "last_insert_rowid": 23}

{"sql": "UPDATE books SET stock = stock + 1 WHERE id = $id", "params": {"id": 23}}
-> {"changes": 1, "last_insert_rowid": null}
```

SQLite `INTEGER` columns hold 64-bit values, so the connection reads them as `bigint`. JSON has no
such type: `sqlite_query` returns a value as an exact string when it falls outside the safe integer
range (±(2^53 − 1)), and keeps ordinary integers as numbers.

```json
{"sql": "SELECT 9007199254740993 AS big, 42 AS small", "response_format": "json"}
-> {"columns": ["big", "small"], "rows": [{"big": "9007199254740993", "small": 42}], "count": 1, "offset": 0, "has_more": false}
```

Read as a `number`, `9007199254740993` would come back as `9007199254740992`; the string keeps the
stored value exact. The same rule applies wherever a tool returns row values, `sqlite_insert_row`
included, while counters such as `count` and `changes` stay numbers.

The server also exposes a `sqlite://schema` resource with the `CREATE` statements for every table,
view and index.

## Requirements

- **Node.js 22.16+** (`node:sqlite` with `statement.columns()`), or **Bun 1.2+**
- A SQLite database file

## Setup

```bash
bun install          # or: npm install
bun run build        # type-checks src/ and scripts/, then compiles src/ to dist/
bun run seed         # optional: creates data/demo.db with a sample bookstore
```

The demo database has four tables (`authors`, `books`, `customers`, `orders`) and one view
(`sales_by_book`), with 6 authors, 22 books, 10 customers and 34 orders.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SQLITE_DB_PATH` | `data/demo.db` next to this package | Database file to open. Relative paths resolve against the working directory; prefer an absolute path. |
| `TRANSPORT` | `stdio` | Set to `http` for Streamable HTTP |
| `PORT` | `3000` | HTTP port (loopback only) |

The database is opened lazily on the first tool call. If the file does not exist, tools return an
error naming the path rather than failing silently.

## Use with an MCP host (stdio)

Claude Desktop (`claude_desktop_config.json`), Cursor, VS Code and similar hosts:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "bun",
      "args": ["C:\\path\\to\\sqlite-mcp-server\\dist\\index.js"],
      "env": {
        "SQLITE_DB_PATH": "C:\\path\\to\\your\\database.db"
      }
    }
  }
}
```

Use `"command": "node"` with the same `args` on Node 22.16+.

To explore the server interactively:

```bash
SQLITE_DB_PATH=./data/demo.db npx @modelcontextprotocol/inspector bun dist/index.js
```

## Use over Streamable HTTP

```bash
TRANSPORT=http PORT=3000 bun dist/index.js
# MCP endpoint: http://127.0.0.1:3000/mcp
```

The HTTP handler is stateless (no sessions) and a fresh server is built per request. It binds
`127.0.0.1` only, and `createMcpExpressApp` validates `Host`/`Origin` headers, which blocks DNS
rebinding: a request whose hostname is not `127.0.0.1`, `localhost` or `[::1]` gets `403` with a
JSON-RPC error naming the offending header (`Invalid Host: …` / `Invalid Origin: …`). Both checks
compare the hostname only, so any port on those three hosts is accepted, and an absent `Origin`
(non-browser client) passes. `bun run smoke` starts this transport on a free loopback port, sends
`initialize` then a `tools/call` to `/mcp`, checks those two refusals, and stops the process again,
so the path is covered without a manual run. The handler authenticates nothing: put a reverse proxy with authentication in front of
`/mcp` before exposing it to a network.

## Safety notes

- `sqlite_query` only accepts `SELECT`/`WITH`/`VALUES`. SQLite silently ignores everything after a
  statement's first `;`, so all tools reject a second statement instead of reporting a partial batch
  as success.
- `sqlite_execute` refuses `PRAGMA` and `ATTACH`, which could change connection settings or reach
  files outside the database.
- Table and column names are validated against the live schema before being quoted as identifiers.
- Every tool opens the same lazily-created connection; `PRAGMA foreign_keys = ON` is set at open.

## Development

```bash
bun run dev          # run src/index.ts directly
bun run build        # type-check src/ and scripts/, then emit src/ to dist/
bun run typecheck    # type-check src/ and scripts/ without emitting
bun run test         # SQL-guard table tests and the offline model-runner tests
bun run coverage:unit # unit coverage with the per-file floors (scripts/check-coverage.ts)
bun run coverage:e2e  # smoke + evals under NODE_V8_COVERAGE, the c8 report and the end-to-end floors
bun run smoke        # exercise every tool over stdio, then the HTTP endpoint and its refusals
bun run evals        # replay every eval question through the tools (deterministic)
bun run evals:model  # let a model choose the tool calls (needs EVAL_API_KEY, EVAL_MODEL)
```

`scripts/smoke.ts`, `scripts/evals.ts` and `scripts/db.test.ts` copy the demo database to a temp
directory first, so write tests never touch `data/demo.db`.

The built server runs on Node 22.16+ (`node dist/index.js`). The scripts are TypeScript, so
`node scripts/smoke.ts` and `node scripts/evals.ts` need Node 22.18+ (or `--experimental-strip-types`
on 22.16–22.17). That constraint is also why the scripts resolve `data/demo.db` themselves instead
of importing `src/`: type stripping refuses the `enum` in `src/constants.ts`, and Node does not
remap `src/`'s `.js` specifiers to the `.ts` files. Node prints
`ExperimentalWarning: SQLite is an experimental feature` on stderr at runtime, including during the
smoke (`node scripts/smoke.ts`): it comes from `node:sqlite` and is not a failure. `bun run test` and `bun run seed` are Bun-only: the tests use `bun:test` and the seed
script imports `src/` directly.

### Coverage

The unit suite never imports `src/index.ts`, so `bun test --coverage` cannot see the entry point:
that needs the built server running in a child process, which Bun does not instrument. End-to-end
coverage therefore uses Node's own V8 dumps, merged with `c8` (a devDependency, so the lockfile
pins it). `bun run coverage:e2e` runs the whole sequence below — CI calls exactly that — and it
needs `node` on `PATH` (or `COVERAGE_NODE` pointing at one), because Bun writes no V8 dumps:

```bash
rm -rf .v8cov coverage-e2e
NODE_V8_COVERAGE="$PWD/.v8cov" node scripts/smoke.ts   # stdio + HTTP, sends a real SIGTERM to the HTTP child
NODE_V8_COVERAGE="$PWD/.v8cov" node scripts/evals.ts   # 11 deterministic questions
./node_modules/.bin/c8 report --temp-directory=.v8cov --reporter=text --reporter=lcov --report-dir=coverage-e2e
bun scripts/check-e2e-coverage.ts                      # the gate; reads coverage-e2e/lcov.info
```

On Windows, set the variable with `$env:NODE_V8_COVERAGE = "$PWD/.v8cov"` and expect the HTTP child
to be missing from the dumps: Windows kills children unconditionally, so its `SIGTERM` handler does
not run and no dump is written. That is why the gate is Linux-only in CI, and why
`bun run coverage:e2e` still writes the report on Windows but skips the floors with a notice.

The smoke forwards `NODE_V8_COVERAGE` to the HTTP child by hand, because the SDK's
`getDefaultEnvironment()` drops it, and `src/index.ts` closes the server and the database on
`SIGTERM`/`SIGINT`, which is what lets the child exit normally and flush its dump.

`bun scripts/check-e2e-coverage.ts` enforces per-file line floors on the three files only this run
reaches: **95 %** for `src/index.ts`, **85 %** for `src/db.ts` and **75 %** for
`src/tools/read.ts`. It fails when a file is absent from the report, when no report exists, or when
uncovered lines drop one of them below its floor. The entry point has no excluded lines: the smoke
also starts the server against a missing `SQLITE_DB_PATH`, which covers the `reportDatabase`
fallback, and no line number appears in the check, so moving that function cannot invalidate it.
The current report is 60/60 lines; `scripts/check-e2e-coverage.test.ts` covers the passing report,
the absent entry point, shifted line numbers and the failing cases.

## Continuous integration

`.github/workflows/ci.yml` runs on every push, on pull requests and on demand. It has nine jobs:
`actionlint`, which checks the workflow file itself with the pinned actionlint 1.7.12, and an
eight-cell matrix of four runtimes (`node-22.16`, `node-22.18`, `node-24`, `bun`) on `ubuntu-latest`
and `windows-latest`. Each matrix job installs with `bun install --frozen-lockfile`, builds,
type-checks, runs the unit suite, then the smoke and the deterministic evals under its own runtime.

Coverage is measured once per run rather than in all eight cells:

| Step | Runs on | What it does |
|---|---|---|
| `Unit tests with coverage (lcov)` | Linux + Bun | `bun test --coverage --coverage-reporter=lcov`; `bunfig.toml` applies a 0.9 floor to every file |
| `Check per-file coverage floors` | Linux + Bun | `scripts/check-coverage.ts`: 100 % for `constants.ts`, `server.ts` and `tools/write.ts`, 90 % for `db.ts` and `format.ts` |
| `Smoke with V8 coverage` and `… evaluations …` | Linux + node-24 | replace the plain smoke and evals, with `NODE_V8_COVERAGE` pointing at `.v8cov` |
| `End-to-end coverage report` | Linux + node-24 | `c8 report` merges the dumps into `coverage-e2e/lcov.info` |
| `Check end-to-end coverage floor (src/index.ts)` | Linux + node-24 | `scripts/check-e2e-coverage.ts`: 95 % for `index.ts`, 85 % for `db.ts`, 75 % for `tools/read.ts` |

The seven other cells run the suite once, without instrumentation. The end-to-end floor stays on
Linux because Windows terminates child processes unconditionally, so its HTTP child never writes a
dump.

Two artefacts are published per run: `coverage-unit` (`coverage/lcov.info`, Bun instrumentation)
and `coverage-e2e` (`coverage-e2e/lcov.info`, V8 dumps merged by c8). Both are downloadable from the
run page, next to each other.

## Evaluations

`evals/evaluation.xml` holds 11 read-only questions over the demo database, each requiring several
tool calls (schema discovery, joins, aggregation); see the [MCP evaluation guide](https://modelcontextprotocol.io)
for the `qa_pair` format.

```bash
bun run build && bun run evals
```

`scripts/evals.ts` parses the XML and, for each question, plays the tool calls a model would make
(`sqlite_list_tables`, `sqlite_describe_table`, `sqlite_query` with named parameters) through a real
stdio client against a temp copy of the demo database. It formats the answer from the last query's
structured rows and asserts it equals the expected answer, so the evaluations are proven through
the server rather than only computed with direct SQL. The check fails when a question has no replay
plan, a tool errors, or an answer differs.

One question reads a list two rows at a time: its plan asserts `has_more` and `next_offset` on the
first page, then asks for the second page with the offset the first one returned.

### Model-driven evaluations

`scripts/evals-model.ts` hands the tools to a model, lets it choose its own calls, and checks that
its final message contains the expected answer as whole words (prose around it is allowed, but a
longer value that merely contains it is not: `15` does not answer `5`).
It is bounded: a turn cap per question and a cost cap for the whole run, computed from the `usage`
block of every response. An endpoint that does not report usage is refused, so the cap cannot be
silently ignored.

The scripted runner above stays the deterministic gate (`bun run evals`); this one answers a
different question: can a model actually drive the tools, and what does that cost?

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVAL_API_KEY` | required | bearer token for the endpoint |
| `EVAL_MODEL` | required | model name sent in every request |
| `EVAL_API_BASE_URL` | `https://freebuff.com/api/v1/paid` | base URL before `/chat/completions` |
| `EVAL_ONLY` | all | run only this question number (1-based) from `evals/evaluation.xml` |
| `EVAL_MAX_TURNS` | `8` | assistant turns allowed per question |
| `EVAL_MAX_COST_USD` | `0.25` | budget for the whole run |
| `EVAL_PRICE_INPUT_PER_MTOK` | `0.15` | USD per million prompt tokens |
| `EVAL_PRICE_OUTPUT_PER_MTOK` | `0.60` | USD per million completion tokens |

The two prices are placeholders: set them to your provider's rates, since the budget is enforced
from them.

The loop and the endpoint client are covered offline by `scripts/evals-model.test.ts`, which runs
them against a fake chat completions endpoint on `127.0.0.1`: a correct answer and the cost it
reports, a wrong answer, the turn cap, the cost cap, a response without a `usage` block, tool
arguments that are not valid JSON, a budget already spent before the next question and the
`EVAL_ONLY` selection of a single question.
`scripts/evals-model-cli.test.ts` runs the CLI itself in a child process with a sanitized
environment, so a missing `EVAL_MODEL` or `EVAL_API_KEY` and a non-numeric `EVAL_MAX_TURNS` or
`EVAL_MAX_COST_USD` are covered before any connection is opened. No key and no model are involved,
so `bun run test` exercises those paths for free.

```bash
EVAL_API_KEY=... EVAL_MODEL=... bun run build && bun run evals:model
```

While tuning a prompt or a tool, `EVAL_ONLY` runs a single question, so iterating does not spend the
whole budget or wait for the other ten:

```bash
EVAL_API_KEY=... EVAL_MODEL=... EVAL_ONLY=3 bun run evals:model
```

Numbers are 1-based, in the order of the file; an out-of-range value fails with the valid range
instead of silently running everything.
