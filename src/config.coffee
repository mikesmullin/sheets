# Workspace resolution. Config (.sheets/) always lives in the launch cwd; --db (and each
# activity's rows.source) may point at any entity database on disk without polluting it.
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export resolveWorkspace = (opts = {}) ->
  root = path.resolve opts.root ? process.cwd()
  sheetsDir = path.join root, '.sheets'
  cfgPath = path.join sheetsDir, 'config.yaml'
  config = {}
  if fs.existsSync cfgPath
    config = yaml.load(fs.readFileSync cfgPath, 'utf8') ? {}
  db = path.resolve root, (opts.db ? config.db ? 'db')
  {
    root, sheetsDir, cfgPath, config, db
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
