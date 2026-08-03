# Workspace resolution. Config (.sheets/) always lives in the launch cwd; --db (and each
# activity's rows.source) may point at any entity database on disk without polluting it.
# Multiple --db flags are supported: each path is scanned for activities (or becomes one tab).
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

# Normalize one or many --db values to an absolute path list (deduped, order preserved).
export resolveDbPaths = (root, dbOpt, configDb) ->
  raw = dbOpt ? configDb ? 'db'
  list = if Array.isArray raw then raw else [raw]
  out = []
  seen = new Set()
  for item in list when item? and String(item).trim() isnt ''
    abs = path.resolve root, String(item).trim()
    continue if seen.has abs
    seen.add abs
    out.push abs
  out.push path.resolve(root, 'db') unless out.length
  out

# A database belongs to at most one sheets server. `wx` makes acquisition atomic
# across concurrent processes; a lock remains intentionally visible after a crash.
export acquireDbLocks = (dbs, info = {}) ->
  locks = []
  file = null
  currentAcquired = false
  try
    for db in dbs
      fs.mkdirSync db, recursive: true
      file = path.join db, '.lock'
      fd = fs.openSync file, 'wx'
      currentAcquired = true
      try
        fs.writeFileSync fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), ...info }, null, 2) + '\n'
      finally
        fs.closeSync fd
      locks.push file
      currentAcquired = false
    locks
  catch err
    fs.rmSync file, force: true if currentAcquired and file?
    fs.rmSync lock, force: true for lock in locks
    if err?.code is 'EEXIST'
      throw new Error "sheets database is locked: #{file} (remove it only after confirming no sheets server is using that database)"
    throw err

export releaseDbLocks = (locks = []) ->
  fs.rmSync file, force: true for file in locks
  null

export resolveWorkspace = (opts = {}) ->
  root = path.resolve opts.root ? process.cwd()
  sheetsDir = path.join root, '.sheets'
  cfgPath = path.join sheetsDir, 'config.yaml'
  config = {}
  if fs.existsSync cfgPath
    config = yaml.load(fs.readFileSync cfgPath, 'utf8') ? {}
  dbs = resolveDbPaths root, opts.db, config.db
  db = dbs[0]
  {
    root, sheetsDir, cfgPath, config, db, dbs
    activitiesDir: path.join sheetsDir, 'activities'
    stagesDir: path.join sheetsDir, 'stages'
    runsDir: path.join sheetsDir, 'runs'
    serverJson: path.join sheetsDir, 'server.json'
    pgdataDir: path.join sheetsDir, 'pgdata'
    port: Number(opts.port ? config.port ? 4400)
    # model resolution: meta.model -> config.yaml -> $FAV_LOCAL_LLM -> AGL default (§4)
    model: config.model ? process.env.FAV_LOCAL_LLM ? null
    concurrency: Number(config.concurrency ? 0)
    indexes: config.indexes ? []
    timeout_ms: Number(config.timeout_ms ? 300000)
  }

export readServerJson = (ws) ->
  try
    JSON.parse fs.readFileSync(ws.serverJson, 'utf8')
  catch
    null

export writeServerJson = (ws, info) ->
  fs.mkdirSync ws.sheetsDir, recursive: true
  fs.writeFileSync ws.serverJson, JSON.stringify(info, null, 2)

export clearServerJson = (ws) ->
  fs.rmSync ws.serverJson, force: true
