# Angela — the sheets stage author. Scaffolded by `sheets init` into
# .angela/agents/angela.coffee.
# Coffee agents MUST use module.exports (angela agent-loader evaluates CJS).
# She writes/edits .sheets/stages/<slug>.coffee files that satisfy the stage contract.
#
# The stage contract is deliberately NOT duplicated here. It is imported at load
# time from `docs/index.html` — the same Stage Developer Contract humans read — so
# there is exactly one source of truth for both audiences. Edit the doc, and
# Angela learns it on the next server start.
fs = require 'node:fs'
path = require 'node:path'

# `sheets serve` publishes SHEETS_PKG_ROOT; $SHEETS_CONTRACT overrides the file outright.
isSheetsRoot = (dir) ->
  try
    JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.name is 'sheets'
  catch
    false

contractCandidates = (ctx) ->
  out = []
  out.push process.env.SHEETS_CONTRACT if process.env.SHEETS_CONTRACT
  out.push path.join(process.env.SHEETS_PKG_ROOT, 'docs', 'index.html') if process.env.SHEETS_PKG_ROOT
  # Fall back to walking up from the agent file / workspace toward an install.
  for seed in [ctx?.agentPath, ctx?.projectRoot, process.cwd()] when seed
    dir = if path.extname(seed) then path.dirname(seed) else seed
    for step in [0...8]
      out.push path.join(dir, 'node_modules', 'sheets', 'docs', 'index.html')
      out.push path.join(dir, 'docs', 'index.html') if isSheetsRoot dir
      parent = path.dirname dir
      break if parent is dir
      dir = parent
  out

# Presentation is noise in a prompt: <style>/<script> are ~40% of the file and
# teach nothing. Everything instructional lives in the markup.
stripChrome = (html) ->
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

loadContract = (ctx) ->
  for candidate in contractCandidates ctx
    try
      continue unless fs.statSync(candidate).isFile()
      return { html: stripChrome(fs.readFileSync candidate, 'utf8'), dir: path.dirname candidate }
    catch
      continue
  null

# Reference repos vendored as git submodules under docs/. Only advertise the ones
# actually checked out — an uninitialized submodule is an empty directory.
referenceIndex = (docsDir) ->
  return null unless docsDir
  refs = [
    ['agl/docs/MICROAGENT.md', 'How AGL microagents are designed. Read before writing an LLM stage.']
    ['agl/src/agents/home.mjs', 'A full worked AGL agent.']
    ['agl/src/agent.mjs', 'AGL Agent source: factory / Tool / run / default.']
    ['m-js-docs/index.html', 'M.js documentation — the view layer used by views.cell and views.mount.']
    ['m-js/src', 'M.js source.']
  ]
  lines = for [rel, why] in refs when fs.existsSync path.join(docsDir, rel)
    "    - #{path.join docsDir, rel}\n      #{why}"
  return null unless lines.length
  """
  ## REFERENCE MATERIAL ON DISK
  These are checked out locally — read them with file_io rather than guessing.
  Paths are absolute; prefer them over any URL.

  #{lines.join '\n'}
  """

module.exports = (ctx) ->
  loaded = loadContract ctx
  contract = loaded?.html
  references = referenceIndex loaded?.dir

  # Never hard-fail the chat UI over a missing doc — degrade to a pointer.
  contractBlock =
    if contract
      """
      ## THE STAGE CONTRACT — AUTHORITATIVE

      The complete Stage Developer Contract follows, verbatim, as HTML. It is the
      same guide the human developers read. Follow its instructions when creating or modifying stage code.

      <stage-developer-contract format="html" source="sheets/docs/index.html">
      #{contract}
      </stage-developer-contract>
      """
    else
      """
      ## THE STAGE CONTRACT — NOT LOADED

      WARNING: the Stage Developer Contract could not be read from disk (expected
      `docs/index.html` in the installed sheets package; override with
      $SHEETS_CONTRACT). Before writing anything, read existing
      `.sheets/stages/*.coffee` files for working examples. Keep to the exports
      meta / gate / reduce / views, CoffeeScript syntax only, and no import
      statements.
      """

  name: 'angela'
  description: 'Sheets stage author: turns one-sentence prompts into stage .coffee files'
  model: process.env.FAV_LOCAL_LLM
  mcp: ['file-io']
  # Single-operator local tool — never block file writes on approval.
  policyMode: 'open'
  # Default angela allowlist is read-only for files; stage authoring needs write.
  allowlist: '''
    file_io__list_dir
    file_io__read_file
    file_io__stat
    file_io__write_file
    file_io__list_dir:.*
    file_io__read_file:.*
    file_io__stat:.*
    file_io__write_file:.*
  '''
  system: """
    You are Angela, the stage author for `sheets`.

    sheets is a spreadsheet where:
    - each ROW is one entity (a YAML file: two-level component -> field map)
    - each COLUMN is one pipeline stage (a CoffeeScript module under .sheets/stages/)
    - Play runs stage.reduce(entity) for selected cells; the returned patch is merged into the entity

    ## YOUR ONLY JOB
    When the user describes a stage (often one sentence) plus a <sheets-context> block:
    1. IMMEDIATELY write or overwrite `.sheets/stages/<slug>.coffee` with `file_io__write_file`.
    2. The slug is given in <sheets-context> as "Focused column stage slug".
    3. You may ask clarifying questions.
    4. Do NOT fill cells yourself.
    5. After the file is written, reply a summary of the changes applied.

    If the stage file is missing, CREATE it. If it exists, EDIT it to match the request.

    ## Tools
    You have file_io tools (list_dir, read_file, write_file) jailed to the workspace.
    Use write_file with path like `.sheets/stages/<slug>.coffee` and the FULL file content.
    Never write entity YAML yourself — stages produce those fields when Play runs.

    ## Style
    - Unix philosophy: one small stage that does one thing well.
    - Prefer writing a NEW field (e.g. animal.noise) over overwriting unrelated fields.
    - Deterministic code for mechanical work; an LLM microagent only for subjective
      or generative work. The contract's "Deterministic vs LLM" and "LLM pattern"
      sections decide this — do not call a model just because the workflow is agentic.

    #{contractBlock}

    #{references ? ''}
  """
