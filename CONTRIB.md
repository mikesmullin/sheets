# Contributing

Design doc: `tmp/PLAN1.md`. Successor to `agent-pipeline`'s walk, `gdedit`'s Table, and
`cowork`'s sheet scene (which deferred "structured agent output → table mapping" — sheets
closes that loop: agent output flows back into the cells and onto disk).

## linked dependencies

`agl-ai` and `angela` are `link:` dependencies — symlinks to the local clones
(`/workspace/agl`, `/workspace/angela`, registered once with `bun link` in each), so editing
those repos updates sheets (and every other linked consumer) immediately.

### Local m-js runtime

The SPA imports `public/m.js`, a hard-linked, non-minified copy of the local build at
`/workspace/m-js/dist/m.js`; it does not load m-js from the cloud CDN. Git commits this as a
normal file. To change the framework, edit `/workspace/m-js/src/`, then rebuild and refresh the
hard link:

```sh
cd /workspace/m-js
bun build.mjs package
ln -f dist/m.js /workspace/sheets/public/m.js
```

`build.mjs` recreates `dist/`, so the final `ln` command is required after each rebuild.

## Concepts

- **Entity** = one YAML file (`db/<id>.yaml`), a two-level `component: {field: value}` map.
  Brain dbs (`db/<Class>/<id>.md`, frontmatter + body) load as-is; markdown bodies survive writes.
- **Activity** = a worksheet tab (`.sheets/activities/<slug>.yaml`): its own `rows.source`
  (one server, many databases) and an ordered column list — `{field: comp.field}` (default
  stage: renders/edits one field, not playable) or `{stage: slug}` (scripted).
- **Stage** = `.sheets/stages/<slug>.coffee`, no imports, everything via `ctx`:
  - `meta` `{title, prompt, writes, model?, timeout_ms?}` (required)
  - `reduce(entity, ctx) -> patch` — pure reducer; shallow two-level merge; values replace
    wholesale; `null` is a value, never a deletion (required)
  - `gate(entity) -> bool` — may this stage run *now*? false parks the queued cell in `idle`
    until a mutation satisfies it (convention: always write one)
  - `views.cell(entity) -> {template}` — self-contained static HTML for the cell (escape!)
  - `sort(a, b)` — optional column comparator
  - LLM stages call `ctx.Agent` (agl-ai) with `output_tool` + `stream: true` + `retries: 0`
    and register via `ctx.onAgent(agent)` so stop/timeout can abort them.
- **Queue**: job = one cell. FIFO; entity lock (resolved file path) makes it impossible for
  two stages to touch one entity concurrently — same-entity selections chain left→right.
  Concurrency slider 0–64 is the single source of truth (also syncs `Agent.default.concurrency`).
- **Run logs**: one YAML per attempt in `.sheets/runs/` (state, patch/error, captured
  console.log lines, model + tokens). Entities never carry bookkeeping. `sheets clean` wipes.
- **A1 coordinates are ephemeral** — nothing on disk stores a column letter; `--range B3:D4`
  and chat references resolve at enqueue time to (entity, stage).

## CLI

The server is required: CLI and browser discover it via `.sheets/server.json` and exit if it's not running.

## Angela (stage author)

`sheets init` scaffolds `.angela/agents/angela.coffee` (system prompt = the stage contract).
Type a sentence in a new column's magic-row box, hit ✨ — Angela writes the stage file, the
server hot-reloads it, press ▶. Model resolution: `meta.model` → `.sheets/config.yaml` →
`$FAV_LOCAL_LLM` → AGL default. Chat requires an AGL-supported provider running (LM Studio etc.).

## Workspace config (`.sheets/config.yaml`)

```yaml
model: lm-studio:google/gemma-4-12b-qat   # optional; else $FAV_LOCAL_LLM
concurrency: 0                            # startup value; slider changes it live
indexes: [produce.name]                   # PGLite expression indexes — config-only, no auto
timeout_ms: 300000
```

YAML on disk is authoritative; the server mirrors every activity source into embedded PGLite
(`.sheets/pgdata/`) for windowing/sort/search.

## Tests

`bun test test/` — engine invariants (entity lock, gate→idle FSM, merge/null semantics,
dedupe, run logs) + the 500-fruit benchmark over the HTTP API with a deterministic stub stage.
