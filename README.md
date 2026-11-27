# sqlite-mcp-server

[![CI](https://github.com/mismi/sqlite-mcp-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mismi/sqlite-mcp-server/actions/workflows/ci.yml?query=branch%3Amain) [![License: MIT](https://img.shields.io/github/license/mismi/sqlite-mcp-server)](https://github.com/mismi/sqlite-mcp-server/blob/main/LICENSE) [![unit coverage: 100% lines](https://img.shields.io/badge/unit%20coverage-100%25%20lines-brightgreen)](#coverage)

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

## Security

The server binds `127.0.0.1` and authenticates nothing: put a reverse proxy with authentication in
front of `/mcp` before exposing it anywhere else. SQL is guarded rather than trusted (single
read-only statement for `sqlite_query`, validated identifiers, `PRAGMA`/`ATTACH` refused), and no
credential is needed to run the server — the optional model evaluations read `EVAL_API_KEY` from the
environment only.

Report a vulnerability privately through GitHub's Security Advisories; [SECURITY.md](SECURITY.md)
describes what is in scope and what is accepted by design. Secret scanning and push protection are
enabled on the repository, and it holds no environment files.

## Development

```bash
bun run dev          # run src/index.ts directly
bun run build        # type-check src/ and scripts/, then emit src/ to dist/
bun run typecheck    # type-check src/ and scripts/ without emitting
bun run test         # SQL-guard table tests and the offline model-runner tests
bun run coverage:unit # unit coverage with the per-file floors (scripts/check-coverage.ts)
bun run coverage:e2e  # smoke + evals under NODE_V8_COVERAGE, the c8 report and the entry-point floor
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

Two reports answer two different questions. The unit suite measures the modules it imports
in-process; the end-to-end report measures the built server while real clients drive it. Neither
replaces the other, so CI enforces both.

The coverage badge at the top restates what this section measures: *unit coverage, 100 % of lines*,
the value `bun run coverage:unit` reports today. It is a static badge, changed by hand when that
number moves, because no coverage service is wired into the repository; the lcov artefacts of each
run (`coverage-unit`, `coverage-e2e`) are the authoritative numbers, and they download from the run
page.

**Unit coverage (Bun).** `bun run coverage:unit` runs `bun test --coverage
--coverage-reporter=lcov`, which instruments, through Bun, every module the tests import, then
applies two layers of floors to `coverage/lcov.info`: `bunfig.toml` fails the run when any file
drops below 0.9, and `scripts/check-coverage.ts` holds the modules the suite owns to per-file
floors — **100 %** for `src/constants.ts`, `src/server.ts` and `src/tools/write.ts`, **90 %** for
`src/db.ts` and `src/format.ts`.

The unit suite never imports `src/index.ts`, so Bun's report cannot see the entry point: measuring
it needs the built server running in a child process, which Bun does not instrument. **End-to-end
coverage** therefore uses Node's own V8 dumps, merged with `c8` (a devDependency, so the lockfile
pins it). `bun run coverage:e2e` runs the whole sequence below — CI calls exactly that — and it
needs `node` on `PATH` (or `COVERAGE_NODE` pointing at one), because Bun writes no V8 dumps:

```bash
rm -rf .v8cov coverage-e2e
NODE_V8_COVERAGE="$PWD/.v8cov" node scripts/smoke.ts   # stdio + HTTP, sends a real SIGTERM to the HTTP child
NODE_V8_COVERAGE="$PWD/.v8cov" node scripts/evals.ts   # 11 deterministic questions
./node_modules/.bin/c8 report --temp-directory=.v8cov --reporter=text --reporter=lcov --report-dir=coverage-e2e
./node_modules/.bin/c8 check-coverage --temp-directory=.v8cov --include=dist/index.js --lines=90 --branches=75  # the gates, one per file
./node_modules/.bin/c8 check-coverage --temp-directory=.v8cov --include=dist/db.js --lines=90 --branches=80
./node_modules/.bin/c8 check-coverage --temp-directory=.v8cov --include=dist/tools/read.js --lines=95 --branches=95
```

The smoke forwards `NODE_V8_COVERAGE` to its children by hand, because the SDK's
`getDefaultEnvironment()` drops it, and `src/index.ts` closes the server and the database on
`SIGTERM`/`SIGINT`, which is what lets the HTTP child exit normally and flush its dump. On Windows,
set the variable with `$env:NODE_V8_COVERAGE = "$PWD/.v8cov"`.

**The floors.** After writing the report, `bun run coverage:e2e` runs c8's own gate once per file,
so each keeps its own thresholds: `dist/index.js` at 90 % of lines and 75 % of branches,
`dist/db.js` at 90 % and 80 %, `dist/tools/read.js` at 95 % and 95 %. Thresholds are percentages,
so 0.9 is written `--lines=90`. Lines alone were not enough: `src/tools/read.ts` was at 251/251
lines while a tenth of its branches — the `has_more` hint, the `unique` marker, the `ANY` fallback
— were never executed. **Branches are gated here and not in the unit gate** because Bun's lcov
reporter writes no `BRDA` records at all (verify with `grep -c '^BRDA:' coverage/lcov.info`: it
returns 0), so `scripts/check-coverage.ts` has nothing to count; c8 reads V8's own branch counts,
which is why the end-to-end gate is the one that can enforce them. The
includes name the built files on purpose: c8 filters its raw script paths *before* applying the
source map, where `src/index.ts` matches nothing, and a gate that matches nothing passes silently;
the built paths select the files, which the report still attributes to `src/`. Three files only,
chosen because the end-to-end run measures what Bun cannot see: the built server's startup, its
missing-database path, its shutdown, and the markdown a host gets when it asks for no format.

**Why 90 % on the entry point.** The entry point has 60 executable lines, and on Linux all 60 are
measured (`60/60`): the stdio path from the smoke, the missing-database startup, and the HTTP path
including its `SIGTERM`/`SIGINT` shutdown. At 90 %, up to six lines can move or be temporarily
uncovered by a refactor without failing CI, while a whole branch left unexercised still does.

**Why 90 % on `src/db.ts`, and 80 % of its branches.** The missing-database start and the HTTP
shutdown drive the module's startup paths, which is why it is measured end to end at all. Once the
smoke reached the pagination, view and guard paths — paged listings and queries, a view with no
keys, and every refusal (write through the read tool, `PRAGMA` through the write tool, an empty
`values`, an unknown table or column, a foreign key violation) — the file moved from 341/383 lines
(**89.03 %**) to 362/383 (**94.52 %**) and from 71.43 % to **83.19 %** of its 113 branches. The 90 %
line floor keeps about 17 lines of slack, the 80 % branch floor about four branches. The uncovered
remainder is structural rather than missing tests: `singleStatement` refuses an empty statement
before it can reach its own guard, and a few `??` and `||` sides only fire on exotic schemas. The
unit suite holds the same file to a 90 % line floor, so this gate guards what only the end-to-end
run reaches.

**Why 95 % on `src/tools/read.ts`.** The tool renders markdown by default, and the smoke used to
exercise only `sqlite_query`, so the list and describe renderings and the empty-result message were
never executed end to end: the file sat at 198/251 lines (**78.88 %**). The smoke now asserts all
three — a markdown `sqlite_list_tables`, a markdown `sqlite_describe_table` of `books` (foreign
keys, indexes and DDL) and a markdown query that returns no rows — and the measurement is
**251/251**. At 95 %, that is twelve lines of slack, while losing any one of the three assertions
costs more than that. The same assertions carry the branch count: 43/49 (**87.76 %**) before, 52/54
(**96.30 %**) once the smoke pages a listing and a query, describes a view with no foreign keys or
indexes, and scans an escaped literal. The 95 % branch floor leaves one branch of slack; the two
the end-to-end run cannot reach are an empty database (an object list with no entries) and a
`UNIQUE` index, which the demo schema does not have.

**Lines 24-27 used to be excluded.** While the smoke only ever started against a seeded database,
the `catch` in `reportDatabase` could not run there, so those lines carried a `/* c8 ignore start */`
… `/* c8 ignore stop */` range — a range c8 treats as covered, which is an assumption, not a
measurement. The smoke now also starts the server with `SQLITE_DB_PATH` pointing at an absent file, asserts the
`No SQLite database at …` message and a clean exit, so lines 24-27 execute and are counted; the
markers are gone and no line number appears in the check, so moving that function cannot
invalidate the gate.

**Why the gate only runs on Linux.** Windows terminates child processes unconditionally: the HTTP
child never receives `SIGTERM`, its handler does not run and no dump is written, so only the stdio
children (36 of the 60 lines, i.e. 60 %) are measured, which would sit below the 90 % floor. A gate
there would fail on missing instrumentation rather than on missing tests. Windows CI jobs skip the step, and `bun run coverage:e2e` still
writes the report locally but skips the check with a notice; Linux is the reference platform. The
current Linux report is 60/60 lines for the entry point.

## Continuous integration

`.github/workflows/ci.yml` runs on every push, on pull requests and on demand; the
[workflow's run history](https://github.com/mismi/sqlite-mcp-server/actions/workflows/ci.yml) lists
each run with its matrix. It has ten jobs:
`actionlint`, which checks the workflow file itself with the pinned actionlint 1.7.12; `gitleaks`,
which scans the whole git history for secrets; and an
eight-cell matrix of four runtimes (`node-22.16`, `node-22.18`, `node-24`, `bun`) on `ubuntu-latest`
and `windows-latest`. Each matrix job installs with `bun install --frozen-lockfile`, builds,
type-checks, runs the unit suite, then the smoke and the deterministic evals under its own runtime.

The `gitleaks` job checks out with `fetch-depth: 0` and runs twice over: the pinned
`gitleaks/gitleaks-action` scans the pull request's own commits and fails the job on a hit, then a
follow-up step reuses the binary that action installed to run `gitleaks git . --log-opts=--all`, so a
key committed long before the pull request is caught too. PR comments are turned off
(`GITLEAKS_ENABLE_COMMENTS: "false"`), which keeps the job at `contents: read`.

### Actions are pinned by commit SHA

Every `uses:` names a full 40-character commit SHA rather than a tag, because a moved tag would
silently change what runs in CI. The release version stays on the same line as a comment, in the
`# vX.Y.Z` form:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

Eight `uses:` lines, five actions: `actions/checkout` three times, `actions/upload-artifact` twice,
`actions/setup-node`, `oven-sh/setup-bun` and `gitleaks/gitleaks-action` once each. `.github/dependabot.yml` watches the
`github-actions` ecosystem daily, grouped in one pull request; a bump rewrites the SHA **and**
the comment together, because the comment is how Dependabot knows which release a SHA stands for —
so that `# vX.Y.Z` must stay in that exact form, and a hand-pinned action without it would be
ignored.

Coverage is measured once per run rather than in all eight cells:

| Step | Runs on | What it does |
|---|---|---|
| `Unit coverage and per-file floors` | Linux + Bun | `bun run coverage:unit`: Bun instrumentation, `bunfig.toml` 0.9 per file, then `scripts/check-coverage.ts` (100 % for `constants.ts`, `server.ts`, `tools/write.ts`; 90 % for `db.ts`, `format.ts`) |
| `End-to-end coverage (smoke, evals, c8, floors)` | Linux + node-24 | `bun run coverage:e2e`: smoke and evals under `NODE_V8_COVERAGE`, `c8 report` into `coverage-e2e/lcov.info`, then `c8 check-coverage` three times — 90 % of lines and 75 % of branches for the entry point (`dist/index.js`), 90 %/80 % for `db.ts` (`dist/db.js`), 95 %/95 % for `tools/read.ts` (`dist/tools/read.js`) |

The six other cells run the suite once, without instrumentation. The end-to-end floors stay on
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
