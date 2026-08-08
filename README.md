# 👻 sheets

Bulk agentic LLM execution via spreadsheets.

Imagine a spreadsheet where **rows are entities, columns are [pipeline](https://www.github.com/mikesmullin/agent-pipeline) stages, and a Play button runs any
lasso-selected slice of (entity × stage) through a concurrency-controlled queue**. 
It's like a cross between Excel AutoFill and Jupyter notebooks.

Includes built-in agentic assistant chat sidebar that can author the stage scripts from one-sentence prompts.

![sheets UI](docs/screenshots/20260803-001950-screenshot.png)

## Quick start

### 1. Install

```sh
bun install       # install deps
bun link          # add `sheets` binary to $PATH
sheets help       # print help text
```

### 2. Run the sample dataset

`docs/examples/fruit/` is a complete, ready-to-run worksheet you can play with —
50 fruit entities and five stage columns, two deterministic and three agentic:

| Column | Kind | Writes |
|---|---|---|
| Fruit color | deterministic | `appearance.color` |
| Fruit eater | deterministic | `animal.name` |
| Average Volume | LLM | `produce.volume_inches_cubed` |
| Animal Sleep Pattern | LLM | `animal.sleep_pattern` |
| Eating noise | LLM | `animal.noise` |

```sh
cd docs/examples/fruit/
sheets serve                        # launch http server
```

Then open **<http://localhost:4400>** in your browser.

### 3. Play with it

1. Click a cell in the **Fruit color** column, or lasso-select a range.
2. Press **Play** to run that slice of (entity × stage) through the queue.
3. Watch the cells fill in, and the log at the bottom.

The two deterministic columns run with no further setup. The three agentic
columns call an LLM per row, so point Sheets at a model first — either
`export FAV_LOCAL_LLM=<provider:model>` in your shell, or uncomment the `model:`
line in `.sheets/config.yaml`.

If cells sit in `queued` forever, the scheduler is paused — raise the
concurrency slider in the UI (or `sheets concurrency 4`).

> The sample workspace is committed with only its dataset: entities, stages,
> activity, and config. The mirror, run logs and compiled stages are generated
> on first run and stay out of git.

## Writing your own stages

Columns are CoffeeScript modules under `.sheets/stages/`. The full contract —
exports, `ctx`, patch semantics, views, RPC, and the entity REST API — is in
**[docs/index.html](docs/index.html)**.

You don't have to write them by hand: the built-in assistant sidebar (Angela)
authors stage files from one-sentence prompts, working from that same contract.