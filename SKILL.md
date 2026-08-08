---
name: sheets
description: "Use when operating the Sheets spreadsheet-driven entity-stage runner: running or diagnosing the server, locating the entity database, troubleshooting the grid, and dividing work between a human operator and an AI assistant. For authoring stages, read docs/index.html."
---

# Sheets Skill

## Start here — the stage contract lives in `docs/index.html`

Everything about **authoring a stage** — the exports, `ctx`, patch and merge
semantics, views (`cell` / `mount` / `text` / `onKey`), stage RPC, the entity
REST API, wiring AGL, and the accumulated best practices — is in:

```text
docs/index.html
```

That page is the single source of truth and is not duplicated here. Angela's
system prompt imports the same file, so the operator, the developer, and the
agent all read one document.

This file covers what the contract does not: **running the server, finding your
data, diagnosing the grid, and how a human operator and an AI assistant split
the work.**

## A database is just a folder of entity files

Sheets does not own your data and does not impose a project layout. A "sheets
db" is simply a **directory containing entity files** (`.yaml`, `.yml`, `.md`).
Point Sheets at any such folder and it becomes rows.

Configuration and data stay separate: `.sheets/` (config, stages, activities,
run logs, the PGlite mirror) always lives in the **launch directory**, while the
entity database may live anywhere on disk and is never polluted with Sheets
metadata.

### How the database directory is chosen

Precedence, highest first:

1. **`--db <dir>`** on the command line. Repeatable — each path is scanned for
   activities, or becomes one worksheet tab:
   ```sh
   sheets serve --db ./fruits/db --db ./veggies/db
   ```
2. **`db:`** in `.sheets/config.yaml`.
3. **`./db`** relative to the launch directory (the default).

Independently, each activity's **`rows.source`** selects that tab's entity
directory — resolved against the workspace root, or given as an absolute path.
So one server process can front several databases at once, each as its own tab.

### How to see which database is live

```sh
sheets ls          # per activity: slug, title, source dir, and column letters
curl -sS http://localhost:4401/api/meta   # root, db, dbs[], activities[].source
```

`sheets ls` is also the quickest way to see the **A1 letters**, which are
positional: hidden columns are skipped and consume no letter.

### One server per database directory

Each db dir holds a `.lock` file containing the owning PID and start time. Only
one Sheets server may use a directory at a time. Before killing anything, verify
the PID really is a `sheets serve`; remove a lock **only** when its PID is dead
and nothing is listening on the port.

### Launch hazard

Always start from the directory that owns `.sheets/`, and prefer `pushd` — a
bare `cd` can be stripped by tooling, silently serving the wrong folder:

```sh
pushd path/to/workspace
sheets serve
popd
```

The signature of this mistake is a server that starts cleanly and reports
**0 entities**.

## Troubleshooting

### The browser shows "disconnected" or 0 entities

The disconnect badge is driven by the client WebSocket to
`ws(s)://<host>/ws/run`. A tab can keep the shell without a live socket even
while the server happily accepts new connections — common in an IDE's embedded
browser after a server restart, an IDE reload, or loading the page while the
process was down.

**Triage first — is it the server or the tab?**

```sh
curl -sS -m 3 http://127.0.0.1:4401/__m_health
# expect: {"ok":true,"hmrClients":…,"runClients":…}

curl -sS -m 3 http://127.0.0.1:4401/api/meta | head -c 400
# expect import.state complete, and your activities listed
```

- Health/meta **fail** → restart the server (mind the launch hazard above), or
  clear a stale `db/.lock` whose PID is dead.
- Health/meta **ok**, and a normal standalone browser works → **do not restart
  the server.** Fix the tab: hard-refresh, or close and reopen on the IPv4
  literal (`http://127.0.0.1:4401/#/a/sheet1`) to dodge `localhost` dual-stack
  quirks. Confirm the badge reads *connected* and the entity count is non-zero.
- Prefer a normal standalone browser for real Play work if the embedded one
  flakes again.

Icon fonts loaded from a public CDN may fail inside an embedded browser. That is
cosmetic and unrelated to the badge.

### Import is incomplete or the mirror is unhealthy

Entity files are authoritative; the PGlite database under `.sheets/pgdata` is a
**disposable** mirror used for windowing, search, sorting and indexes. Throw it
away whenever it looks wrong:

1. Stop `sheets serve`.
2. Run `sheets rebuild`.
3. Wait for the import to report `state: complete` before using the grid.

```sh
curl -sS http://localhost:4401/api/import   # expect state: complete
```

A temporary `0 entities` during import is normal — check `/api/import` before
diagnosing it as data loss.

### What needs a refresh vs. a restart

This wastes more time than anything else on the list.

| Changed | Needed |
|---|---|
| `views` / anything in `lib/views.mjs`, `lib/cell.mjs` | browser refresh |
| `reduce` / a server-only lib | **server restart** (Bun caches the dynamic import) |
| A browser-safe lib that `gate` or `reduce` imports | **server restart** — only the browser route stamps mtimes |
| `src/server.coffee`, `public/app.js` | server restart |
| `.sheets/config.yaml` | server restart (startup values) |

### A stage loads on the server but cells render empty

**Server load is not proof.** A clean `GET /api/stage/<slug>` only proves the
*server* imported the module; `views.js` returning `200` only proves text was
served. Neither proves the browser can render it. Finish by reading a real cell:

```js
document.querySelector('tbody.virtual-body tr.virtual-row td:nth-child(3)').innerText
```

An empty cell with no visible error is almost always a **browser module-load
failure**. Check the console for a CORS or `node:` error — the browser imports
the whole stage module to render a cell, so one server-only import anywhere in
the static import graph blanks the entire column.

### Stage header appears but cells are empty

1. Check the activity uses `{stage: <slug>}`.
2. Check the file exists at `.sheets/stages/<slug>.coffee`.
3. Check `meta`, `gate`, `reduce`, `views` are explicitly exported.
4. Check `GET /api/stage/<slug>` for compile/import errors.
5. Check `GET /api/stage/<slug>/views.js` returns `200`.
6. Refresh the browser.

### `[object Object]` appears in a cell

A view interpolated an object with normal string coercion. Replace it with an
explicit JSON display helper and escape the result. Do not silently flatten or
invent a scalar representation for structured evidence.

### Stage edits are not visible

The server watches stage files and the browser can hot-reload view modules, but
a browser refresh is the reliable operator action. If the module still 404s,
inspect `GET /api/stage/<slug>` for a compile/import error, and keep the module
small — a very large generated stage can hit Bun's import limits.

### Cells stuck in one state

- **`queued` forever** → concurrency is `0`. Nothing is running; raise the
  slider. It persists to `.sheets/config.yaml` and is a server-wide queue
  property, not per-browser state.
- **`idle`** → the gate returned false. The stage is parked deliberately until
  an upstream field is filled. Don't debug gate logic when the queue simply has
  no workers.

### Reading a cell's validity indicator

Well-written columns distinguish *why* a value is or isn't trustworthy. When
triaging, read the status rather than the raw value:

| Status | Meaning |
|---|---|
| `VALID` | Persisted preflight or capability evidence passed. |
| `UNVERIFIED` | A value is known, but its supporting evidence is absent or failed — often a credential or connectivity problem, **not** a bad value. |
| `PROPOSED` | The view is showing a fallback that a later operator-run stage would write. |
| `UNASSIGNED` | No resolved value or evidence exists yet. |

`UNVERIFIED` is the one that saves time: it means "don't go fix the data, go fix
the connection."

### Read-only checks that never execute a stage

Safe to run at any time, including by an AI assistant:

```text
GET /__m_health
GET /api/meta
GET /api/import
GET /api/stages
GET /api/entities?activity=<slug>&offset=0&limit=<n>
GET /api/stage/<slug>
GET /api/stage/<slug>/views.js
```

These inspect configuration, import state, entity rows, and compiled stage
delivery. They are **not** a substitute for an operator-run stage.

### CLI

```text
sheets serve | rebuild | init | run | stop | status
       concurrency [n] | ls | cat <id|stage> | clean
```

Global options include `--db <dir>` (repeatable), `--server <url>`, and
`--json`. Selection flags for `run`/`stop` include `--activity`, `--entities`,
`--stages`, and `--range`.

**Don't trust this summary over the tool.** For the current, authoritative list
of commands, flags and semantics:

```sh
sheets help
sheets help <command>
```

Note that `--dry` still evaluates a reducer and `--detach` still queues work —
both are **execution**, not inspection.

## Working collaboratively (human operator + AI assistant)

### Division of labor

The runner can mutate many authoritative entity files quickly, and stages may
perform irreversible remote writes. Execution is therefore operator-owned.

An AI assistant **may**: read stage source, activity YAML, entity files and run
logs; edit stage code and configuration on request; compile CoffeeScript
statically; call the read-only endpoints above; and explain exactly which cells
to select and what patch to expect.

An AI assistant **must not**: click Play or Run selection; call `/api/run`,
`/api/run/range`, `/api/dry-run` or `/api/rpc`; run `sheets run` or
`sheets stop`; import a stage module to invoke `gate`, `reduce` or `rpc`
directly; or treat a rendered view as proof that a reducer ran.

A stage result is not assumed until the **operator** confirms it from the UI or
the run log.

### Operator browser workflow

1. Open or reuse the browser tab at the server URL.
2. Confirm the status reads *connected*.
3. Confirm the activity tab.
4. Use the Columns control to show/hide columns. Stage columns appear under
   their `meta.title` once the module loads.
5. Use search to locate an entity or a value.
6. Select cells with the grid/lasso selection.
7. **Review the rendered value, badge and tooltip before running anything.**
8. You, the operator, click Play / run-selection.
9. Watch the bottom log, the cell state, and the resulting value.
10. Refresh after external stage-file edits or when a view was cached.

### Adding a column, end to end

1. Write or extend a **lib** function that does the work and returns a two-level
   patch.
2. Add its renderer to `lib/views.mjs` (browser-safe; escape everything).
3. Create `.sheets/stages/<slug>.coffee` containing only the contract exports
   and call-throughs.
4. Set `meta.writes` to the real patch paths; set `timeout_ms` above any login
   or long-call window.
5. Add `{stage: <slug>}` to the activity.
6. Validate: `node --check` the libs, `bunx coffee --compile --print` the stage,
   confirm `/api/stage/<slug>` has no `meta.error` and
   `/stagemod/stages/<slug>.mjs` returns `200`.
7. Restart the server (server-side lib), refresh the browser, and confirm a real
   cell renders.
8. Hand it to the operator to run **one** cell first. Never press Play yourself.
