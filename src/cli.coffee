# sheets CLI (§11): thin client over the HTTP API. The server is a hard requirement —
# no embedded fallback; fail fast with stderr advice (§13). Meter aesthetic ported from
# pipeline run/walk: braille spinner + 24-bit cyan→green gradient bar, plain lines non-TTY.
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import * as CFG from './config.coffee'

HELP = """
sheets — spreadsheet-driven entity × stage pipeline

Usage:
  sheets [command] [options]

Commands:
  serve             start the server (SPA + API) for this workspace
  init              scaffold .sheets/ and .angela/ in this workspace
  run               enqueue entities × stages and follow progress (walk successor)
  stop              dequeue queued / abort running cells
  status            queue snapshot + per-stage tallies
  concurrency [n]   get or live-set the scheduler concurrency (0 = pause)
  ls                list activities, columns/stages, or entities
  cat <id|stage>    print one entity (yaml) or one stage (coffee)
  clean             remove temporary files (.sheets/runs/ logs, server.json litter)
  help [command]

Global options:
  --db <dir>        entity database dir (default: ./db); may point at a brain
                    or agent-pipeline db — config stays in ./.sheets either way
  --server <url>    attach to a running server (default: auto-discover via
                    .sheets/server.json; exits with advice if none is running)
  --json            machine-readable output
"""

RUN_HELP = """
Enqueue a slice of entities × stages, then follow the queue.

Usage:
  sheets run [selection...] [options]

Selection (compose freely; at least one required):
  --activity <slug>            activity context (default: first activity)
  --range <A1-style[,...]>     spreadsheet notation: B3:D4, B:B, 4:4, B4,D5,D6
  --entities <list|a..b>       ids or id-ranges
  --stages <list>              stage slugs (lenient matching)
  --all                        every entity × every scripted stage in the activity

Options:
  -c, --concurrency <n>        set live concurrency before starting
  --dry                        dry-run: print patch + before/after diff, persist nothing
  --detach                     enqueue and exit without following
  --json
"""

parseArgs = (argv) ->
  args = { _: [] }
  i = 0
  while i < argv.length
    a = argv[i]
    if a is '--json' or a is '--dry' or a is '--detach' or a is '--all' or a is '--help'
      args[a.slice 2] = true
    else if a is '-h'
      args.help = true
    else if a is '-c' or a is '--concurrency'
      args.concurrency = argv[++i]
    else if a.startsWith '--'
      args[a.slice 2] = argv[++i]
    else
      args._.push a
    i++
  args

die = (msg) ->
  process.stderr.write msg + '\n'
  process.exit 1

serverUrl = (ws, args) ->
  return args.server if args.server
  info = CFG.readServerJson ws
  unless info?.port
    die "no sheets server running for this workspace — start one with: sheets serve"
  # stale server.json check
  try
    process.kill info.pid, 0
  catch
    die "stale .sheets/server.json (pid #{info.pid} gone) — start a server with: sheets serve"
  "http://localhost:#{info.port}"

api = (base, p, opts = {}) ->
  res = await fetch base + p, opts
  die "server error #{res.status}: #{await res.text()}" unless res.ok
  await res.json()

post = (base, p, body) ->
  api base, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }

# --- meter (pipeline walk aesthetic) -------------------------------------------
BRAILLE = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
lerp = (a, b, t) -> Math.round a + (b - a) * t
barColor = (t) -> "\x1b[38;2;#{lerp 0, 80, t};#{lerp 200, 220, t};#{lerp 220, 120, t}m"

renderBar = (snap, spin) ->
  total = snap.queued + snap.idle + snap.running + snap.done + snap.error
  done = snap.done + snap.error
  width = 30
  t = if total > 0 then done / total else 0
  filled = Math.round width * t
  bar = ''
  for i in [0...width]
    tt = i / Math.max(1, width - 1)
    bar += if i < filled then "#{barColor tt}█\x1b[0m" else "\x1b[38;2;60;60;70m░\x1b[0m"
  err = if snap.error then " \x1b[31m✗#{snap.error}\x1b[0m" else ''
  idle = if snap.idle then " idle:#{snap.idle}" else ''
  "#{BRAILLE[spin % BRAILLE.length]} #{bar} #{done}/#{total} run:#{snap.running}#{idle}#{err} c:#{snap.concurrency}"

follow = (base, jsonMode) ->
  wsUrl = base.replace(/^http/, 'ws') + '/ws/run'
  sock = new WebSocket wsUrl
  tty = process.stdout.isTTY
  spin = 0
  lastPct = -1
  snap = null
  finish = null
  donePromise = new Promise (resolve) -> finish = resolve
  timer = setInterval ->
    return unless snap
    if tty
      process.stdout.write "\r\x1b[2K" + renderBar(snap, spin++)
    null
  , 120
  sock.onmessage = (msg) ->
    ev = JSON.parse msg.data
    if ev.type is 'queue'
      snap = ev
      total = ev.queued + ev.idle + ev.running + ev.done + ev.error
      done = ev.done + ev.error
      unless tty
        pct = if total then Math.floor(done / total * 20) * 5 else 0
        if pct isnt lastPct
          lastPct = pct
          process.stdout.write "#{pct}% (#{done}/#{total}, errors #{ev.error})\n"
      if total > 0 and ev.queued + ev.idle + ev.running is 0
        finish ev
    else if ev.type is 'log' and not tty
      process.stdout.write "#{new Date(ev.ts).toISOString().slice 11, 19} #{ev.stage} #{ev.entity} #{ev.line}\n"
    else if ev.type is 'log' and tty
      process.stdout.write "\r\x1b[2K#{colorize ev.stage}#{' '}#{colorize ev.entity} #{ev.line}\n"
  sock.onerror = -> finish null
  sock.onclose = -> finish snap
  result = await donePromise
  clearInterval timer
  process.stdout.write "\r\x1b[2K" + (if result then renderBar(result, 0) else '') + "\n" if tty
  try sock.close()
  result

# deterministic name-hash color (§6 Μ)
colorize = (s) ->
  h = 0
  h = (h * 31 + s.charCodeAt(i)) | 0 for i in [0...s.length]
  hue = Math.abs(h) % 360
  c = hslToRgb hue / 360, 0.6, 0.6
  "\x1b[38;2;#{c[0]};#{c[1]};#{c[2]}m#{s}\x1b[0m"

hslToRgb = (h, s, l) ->
  hue2rgb = (p, q, t) ->
    t += 1 if t < 0
    t -= 1 if t > 1
    return p + (q - p) * 6 * t if t < 1 / 6
    return q if t < 1 / 2
    return p + (q - p) * (2 / 3 - t) * 6 if t < 2 / 3
    p
  q = if l < 0.5 then l * (1 + s) else l + s - l * s
  p = 2 * l - q
  [Math.round(hue2rgb(p, q, h + 1 / 3) * 255), Math.round(hue2rgb(p, q, h) * 255), Math.round(hue2rgb(p, q, h - 1 / 3) * 255)]

# --- selection resolution -------------------------------------------------------
expandIds = (spec, allIds) ->
  out = []
  for part in String(spec).split ','
    part = part.trim()
    continue unless part
    if part.includes '..'
      [a, b] = part.split '..'
      ia = if a then allIds.indexOf(a) else 0
      ib = if b then allIds.indexOf(b) else allIds.length - 1
      ia = 0 if ia < 0
      ib = allIds.length - 1 if ib < 0
      out.push allIds[i] for i in [ia..ib]
    else
      out.push part
  out

# --- commands -------------------------------------------------------------------
cmdRun = (ws, args) ->
  return process.stdout.write RUN_HELP + '\n' if args.help
  base = serverUrl ws, args
  meta = await api base, '/api/meta'
  activity = args.activity ? meta.activities[0]?.slug
  die 'no activities in this workspace — open the SPA or add .sheets/activities/*.yaml' unless activity
  act = (a for a in meta.activities when a.slug is activity)[0]
  die "unknown activity '#{activity}'" unless act
  if args.concurrency?
    await post base, '/api/queue/concurrency', { n: Number args.concurrency }

  cells = []
  if args.range
    r = await post base, '/api/run/range', { activity, range: args.range } unless args.dry
    if args.dry
      die '--dry with --range not yet supported; use --entities/--stages'
    process.stdout.write "enqueued #{r.added} (resolved #{r.resolved}, skipped field-cols: #{r.skipped.length})\n"
  else
    stageSlugs = (c.stage for c in act.columns when c.stage?)
    stages = if args.stages
      want = args.stages.split(',').map (s) -> s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
      (s for s in stageSlugs when s.toLowerCase().replace(/[^a-z0-9]/g, '') in want)
    else if args.all then stageSlugs
    else null
    die 'selection required: --range, --entities/--stages, or --all (see sheets run --help)' unless stages?.length or args.entities
    stages ?= stageSlugs
    ents = await api base, "/api/entities?activity=#{activity}&limit=500000"
    allIds = (row.id for row in ents.rows)
    ids = if args.entities then expandIds(args.entities, allIds) else allIds
    if args.dry
      for stage in stages
        res = await post base, '/api/dry-run', { activity, stage, ids }
        die res.error unless res.ok
        for r in res.results
          status = if r.ok then '\x1b[32m✓\x1b[0m' else "\x1b[31m✗ #{r.error}\x1b[0m"
          process.stdout.write "#{status} #{colorize stage} #{colorize r.id}\n"
          if r.ok
            for comp, fields of r.patch
              process.stdout.write "    ~ #{comp}: #{JSON.stringify fields}\n"
          process.stdout.write "    · #{l}\n" for l in (r.log ? [])
      return
    cells = []
    for stage in stages
      cells.push { id, stage } for id in ids
    r = await post base, '/api/run', { activity, cells }
    process.stdout.write "enqueued #{r.added} cells\n"
  return if args.detach
  snap = await follow base, args.json
  if args.json
    process.stdout.write JSON.stringify(snap) + '\n'
  process.exit if snap?.error then 1 else 0

cmdStatus = (ws, args) ->
  base = serverUrl ws, args
  q = await api base, '/api/queue'
  if args.json
    process.stdout.write JSON.stringify(q) + '\n'
  else
    s = q.snapshot
    process.stdout.write "queued #{s.queued}  idle #{s.idle}  running #{s.running}  done #{s.done}  error #{s.error}  concurrency #{s.concurrency}\n"
    byStage = {}
    for c in q.cells
      byStage[c.stage] ?= { done: 0, error: 0, other: 0 }
      k = if c.state in ['done', 'error'] then c.state else 'other'
      byStage[c.stage][k]++
    for stage, t of byStage
      process.stdout.write "  #{colorize stage}: ✓#{t.done} ✗#{t.error} …#{t.other}\n"

cmdInit = (ws) ->
  fs.mkdirSync ws.stagesDir, recursive: true
  fs.mkdirSync ws.activitiesDir, recursive: true
  fs.mkdirSync path.join(ws.root, '.angela', 'agents'), recursive: true
  unless fs.existsSync ws.cfgPath
    fs.writeFileSync ws.cfgPath, "# sheets workspace config\n# model: lm-studio:google/gemma-4-12b-qat\nconcurrency: 0\nindexes: []\n"
  agentFile = path.join ws.root, '.angela', 'agents', 'angela.coffee'
  unless fs.existsSync agentFile
    tpl = fs.readFileSync path.join(PKG_ROOT, 'templates', 'angela.coffee'), 'utf8'
    fs.writeFileSync agentFile, tpl
  unless fs.existsSync path.join ws.activitiesDir, 'sheet1.yaml'
    fs.writeFileSync path.join(ws.activitiesDir, 'sheet1.yaml'),
      yaml.dump { title: 'Sheet1', rows: { source: (path.relative(ws.root, ws.db) or 'db') }, columns: [] }
  fs.mkdirSync ws.db, recursive: true
  process.stdout.write "initialized sheets workspace at #{ws.root}\n"

cmdClean = (ws) ->
  n = 0
  if fs.existsSync ws.runsDir
    for f in fs.readdirSync ws.runsDir
      fs.rmSync path.join(ws.runsDir, f), force: true
      n++
  info = CFG.readServerJson ws
  if info?
    alive = true
    try process.kill info.pid, 0 catch then alive = false
    unless alive
      CFG.clearServerJson ws
      process.stdout.write "removed stale server.json\n"
  process.stdout.write "removed #{n} run logs\n"

cmdLs = (ws, args) ->
  base = serverUrl ws, args
  meta = await api base, '/api/meta'
  for a in meta.activities
    process.stdout.write "#{a.slug}  (#{a.title})  #{a.source}\n"
    vi = 0
    for c in a.columns
      kind = if c.stage? then "stage:#{c.stage}" else if c.field? then "field:#{c.field}" else "(empty)"
      if c.hidden
        process.stdout.write "  ·  #{kind}  (hidden)\n"
      else
        letter = if vi < 26 then String.fromCharCode(65 + vi) else String(vi)
        process.stdout.write "  #{letter}  #{kind}\n"
        vi++

cmdCat = (ws, args) ->
  base = serverUrl ws, args
  name = args._[1]
  die 'usage: sheets cat <entityId|stageSlug>' unless name
  activity = args.activity ? null
  st = await api base, "/api/stage/#{encodeURIComponent name}"
  if st.source?
    process.stdout.write st.source
    return
  e = await api base, "/api/entity/#{encodeURIComponent name}" + (if activity then "?activity=#{activity}" else '')
  die "not found: #{name}" unless e.doc?
  process.stdout.write yaml.dump e.doc

cmdConcurrency = (ws, args) ->
  base = serverUrl ws, args
  n = args._[1]
  if n?
    r = await post base, '/api/queue/concurrency', { n: Number n }
    process.stdout.write "concurrency = #{r.concurrency}\n"
  else
    q = await api base, '/api/queue'
    process.stdout.write "concurrency = #{q.snapshot.concurrency}\n"

cmdStop = (ws, args) ->
  base = serverUrl ws, args
  await post base, '/api/stop', { all: true }
  process.stdout.write "stopped\n"

import { fileURLToPath } from 'node:url'
PKG_ROOT = path.resolve path.dirname(fileURLToPath(import.meta.url)), '..'

export main = (argv) ->
  args = parseArgs argv
  if (args.help and argv[0] in ['--help', '-h']) or argv.length is 0
    process.stdout.write HELP + '\n'
    return
  cmd = args._[0] ? 'help'
  ws = CFG.resolveWorkspace { root: process.cwd(), db: args.db, port: args.port }
  switch cmd
    when 'serve'
      { startServer } = await `import('./server.coffee')`
      await startServer { root: ws.root, db: args.db, port: args.port }
    when 'init' then cmdInit ws
    when 'run' then await cmdRun ws, args
    when 'stop' then await cmdStop ws, args
    when 'status' then await cmdStatus ws, args
    when 'concurrency' then await cmdConcurrency ws, args
    when 'ls' then await cmdLs ws, args
    when 'cat' then await cmdCat ws, args
    when 'clean' then cmdClean ws
    when 'help'
      if args._[1] is 'run' then process.stdout.write RUN_HELP + '\n'
      else process.stdout.write HELP + '\n'
    else
      if args.help then process.stdout.write HELP + '\n'
      else die "unknown command: #{cmd}\n#{HELP}"
  null
