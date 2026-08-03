# The sheets server (§2, §10): owns the files, runs stages, hosts Angela.
# HTTP API + /ws/run NDJSON event fan-out + static SPA. Browser and CLI are peer clients.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import * as CFG from './config.coffee'
import * as E from './entities.coffee'
import { Store } from './store.coffee'
import { Activities } from './activities.coffee'
import { Stages } from './stages.coffee'
import { Engine } from './engine.coffee'
import * as A1 from './a1.coffee'
import { createChatApi } from './chat.mjs'

PKG_ROOT = path.resolve path.dirname(fileURLToPath(import.meta.url)), '..'
PUBLIC = path.join PKG_ROOT, 'public'

MIME =
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript'
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml'
  '.png': 'image/png', '.ico': 'image/x-icon'

json = (data, status = 200) ->
  new Response JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }

validEntityId = (value) ->
  id = String(value ? '').trim()
  return null unless /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test id
  return null if id.split('/').some (part) -> part in ['.', '..']
  id

nextEntityId = (source) ->
  n = 1
  loop
    id = "entity-#{n}"
    return id unless E.fileFor source, id
    n++

isFruitEaterPrompt = (prompt) ->
  /animal/i.test(prompt) and /fruit/i.test(prompt) and /(eat|eats|eating|likes)/i.test(prompt)

fruitEaterStage = (prompt) ->
  """
# Authored by Angela's local fruit-eater template. It is deterministic so the example works
# without requiring a tool-call-capable model provider.
export meta =
  title: 'Fruit eater'
  prompt: #{JSON.stringify prompt}
  writes: ['animal.name']

export gate = (entity) ->
  entity.produce?.name?

animals =
  apple: 'Black bear'
  crabapple: 'Black bear'
  apricot: 'Ring-tailed lemur'
  banana: 'Capuchin monkey'
  blackberry: 'Red fox'
  blueberry: 'American robin'
  cantaloupe: 'Raccoon'
  cherry: 'Cedar waxwing'
  clementine: 'Orangutan'
  coconut: 'Coconut crab'
  cranberry: 'Wild turkey'
  date: 'Dromedary camel'
  dragonfruit: 'Fruit bat'
  durian: 'Asian elephant'
  fig: 'Fig parrot'
  grape: 'European starling'
  grapefruit: 'Kinkajou'
  guava: 'Green iguana'
  honeydew: 'Brown bear'
  jackfruit: 'Asian elephant'
  kiwi: 'Common brushtail possum'
  lemon: 'Vervet monkey'
  lime: 'Green iguana'
  lychee: 'Flying fox'
  mango: 'Indian flying fox'
  orange: 'Orangutan'
  papaya: 'Toucan'
  peach: 'White-tailed deer'
  pear: 'Black bear'
  pineapple: 'Coati'
  pomegranate: 'House sparrow'
  raspberry: 'Red fox'
  strawberry: 'Eastern cottontail'
  watermelon: 'Striped skunk'

export reduce = (entity, ctx) ->
  fruit = String(entity.produce.name).toLowerCase()
  animal = animals[fruit] ? 'Fruit bat'
  ctx.log fruit + ' → ' + animal
  animal: name: animal

esc = (s) -> String(s ? '').replace /[&<>"']/g, (c) -> '&#' + c.charCodeAt(0) + ';'
wiki = (name) -> 'https://en.wikipedia.org/wiki/' + encodeURIComponent(name.replace /\s+/g, '_')

export views =
  cell: (entity) ->
    animal = entity.animal?.name ? ''
    return template: '<span style="color:#8b8f99">—</span>' unless animal
    url = wiki animal
    template: '<a class="animal-link" href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(animal) + '</a>'
"""

export startServer = (opts = {}) ->
  ws = CFG.resolveWorkspace opts
  store = await new Store(ws, memory: opts.memory).init()
  activities = new Activities ws
  stages = new Stages ws
  engine = new Engine ws, store, stages
  engine.setConcurrency ws.concurrency
  chat = createChatApi ws, { stages, activities, store, engine }
  sockets = new Set()
  watchers = []

  broadcast = (ev) ->
    msg = JSON.stringify ev
    sock.send msg for sock from sockets
    null
  persisted = (resource, data = {}) ->
    ev = { type: 'persisted', resource }
    ev[key] = value for key, value of data
    broadcast ev
    null
  engine.on 'event', (ev) ->
    if ev.type is 'entity'
      persisted 'entity', { source: ev.source, id: ev.id }
    else
      broadcast ev

  # --- fs watchers: hot-reload stages + external entity edits (§8) ---------------
  watchSafe = (dir, fn) ->
    return unless fs.existsSync dir
    try
      watchers.push fs.watch dir, { recursive: true }, fn
    catch e
      console.error "watch failed for #{dir}: #{e.message}"

  debounces = new Map()
  debounce = (key, ms, fn) ->
    clearTimeout debounces.get key
    debounces.set key, setTimeout(fn, ms)

  watchSafe ws.stagesDir, (event, fname) ->
    return unless fname?.endsWith '.coffee'
    slug = fname.replace /\.coffee$/, ''
    debounce "stage:#{slug}", 150, ->
      stages.invalidate slug
      persisted 'stage', { slug }

  watchSafe ws.activitiesDir, (event, fname) ->
    return unless fname?.match /\.ya?ml$/
    slug = fname.replace /\.ya?ml$/, ''
    debounce "activity:#{slug}", 150, ->
      await loadAll()
      persisted 'activity', { slug }

  watchedSources = new Set()
  watchSource = (dir) ->
    dir = path.resolve dir
    return if watchedSources.has dir
    watchedSources.add dir
    watchSafe dir, (event, fname) ->
      return unless fname? and path.extname(fname) in E.EXTS
      file = path.join dir, fname
      debounce "ent:#{file}", 150, ->
        { id, doc } = await store.refreshFile dir, file
        persisted 'entity', { source: dir, id }
        engine.pump()   # external mutation may satisfy idle gates (§5)

  # load every activity source into the PGLite mirror
  loadAll = ->
    dirs = new Set(a.source for a in activities.list())
    dirs.add ws.db
    for dir from dirs when fs.existsSync dir
      n = await store.loadSource dir
      watchSource dir
      console.log "sheets: loaded #{n} entities from #{dir}"
    null
  await loadAll()

  resolveActivity = (slug) ->
    a = activities.get slug
    a ? (activities.list()[0] ? { slug: null, source: ws.db, columns: [] })

  displayCache = new Map()
  displayFields = (source) ->
    unless displayCache.has source
      displayCache.set source, E.displayFieldsFor source
    displayCache.get source

  # order ids for a source per sort spec; comparator sort loads docs in-memory (§4 sort)
  orderedIds = (activity, sort = null) ->
    if sort?.stage
      mod = await stages.load sort.stage
      if typeof mod?.sort is 'function'
        rows = await store.window activity.source, { offset: 0, limit: 1000000 }
        rows.sort (x, y) -> mod.sort(x.doc, y.doc) * (if sort.dir is 'desc' then -1 else 1)
        return (r.id for r in rows)
    if sort?.field
      rows = await store.window activity.source, { offset: 0, limit: 1000000, orderPath: sort.field, dir: sort.dir }
      return (r.id for r in rows)
    await store.allIds activity.source, sort?.dir ? 'asc'

  handle = (req) ->
    url = new URL req.url
    p = url.pathname

    # ---- websocket upgrade ----
    if p is '/ws/run'
      return undefined if server.upgrade req
      return new Response 'upgrade failed', status: 400

    # ---- chat (angela) ----
    if p.startsWith '/api/chat'
      r = await chat.handle req, url
      return r if r?

    # ---- api ----
    if p is '/api/meta'
      acts = activities.list()
      return json {
        root: ws.root, db: ws.db, port: ws.port
        model: ws.model, chat: chat.enabled()
        activities: ({ slug: a.slug, title: a.title, source: a.source, columns: a.columns, componentLocks: a.componentLocks, revision: a.revision } for a in acts)
      }

    if p is '/api/stages'
      out = []
      for slug in stages.list()
        meta = try await stages.meta slug catch then null
        out.push { slug, title: meta?.title ? slug }
      return json { stages: out }

    if p is '/api/entities' and req.method is 'GET'
      a = resolveActivity url.searchParams.get('activity')
      sortStage = url.searchParams.get 'sortStage'
      sortField = url.searchParams.get 'sortField'
      dir = url.searchParams.get('dir') ? 'asc'
      offset = Number(url.searchParams.get('offset') ? 0)
      limit = Math.min 500, Number(url.searchParams.get('limit') ? 100)
      q = url.searchParams.get('q') or null
      total = await store.count a.source, q
      if sortStage or sortField
        ids = await orderedIds a, { stage: sortStage, field: sortField, dir }
        ids = ids.slice offset, offset + limit
        rows = []
        for id in ids
          rows.push { id, doc: await store.get(a.source, id) }
      else
        rows = await store.window a.source, { offset, limit, dir, q }
      df = displayFields a.source
      rows = ({ id: r.id, doc: r.doc, label: E.labelFor(r.id, r.doc, df) } for r in rows)
      return json { total, offset, rows }

    if p is '/api/fields'
      a = resolveActivity url.searchParams.get('activity')
      fields = await store.fieldPaths a.source
      schema = E.componentFieldsFor a.source
      components = if schema.length then schema else do ->
        grouped = new Map()
        for field in fields
          [component, ...rest] = field.split '.'
          continue unless component and rest.length
          grouped.set(component, []) unless grouped.has component
          grouped.get(component).push rest.join '.'
        ({ component, fields: names } for [component, names] from grouped)
      return json { fields, components, schema: schema.length > 0 }

    if p is '/api/entities' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      id = validEntityId(body.id) ? nextEntityId(a.source)
      return json { error: 'invalid entity id' }, 400 unless id
      return json { error: 'entity already exists' }, 409 if E.fileFor(a.source, id)
      file = path.join a.source, "#{id}.yaml"
      doc = body.doc ? {}
      return json { error: 'entity document must be an object' }, 400 unless doc? and typeof doc is 'object' and not Array.isArray doc
      E.writeEntityFile file, doc
      await store.upsert a.source, id, doc, fs.statSync(file).mtimeMs
      persisted 'entity', { source: a.source, id }
      return json { ok: true, id, doc }

    if p is '/api/entities/delete' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      ids = Array.from new Set((String(id) for id in (body.ids ? []) when validEntityId id))
      return json { error: 'no valid entity ids supplied' }, 400 unless ids.length
      files = []
      for id in ids
        file = E.fileFor a.source, id
        return json { error: "not found: #{id}" }, 404 unless file
        files.push { id, file }
      for { id, file } in files
        engine.stop ({ source: a.source, id, stage } for stage in stages.list())
        fs.rmSync file, force: true
        await store.remove a.source, id
        persisted 'entity', { source: a.source, id }
      return json { ok: true, deleted: (entry.id for entry in files) }

    if p is '/api/entities/blank' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      items = body.items ? []
      return json { error: 'no cells supplied' }, 400 unless Array.isArray(items) and items.length
      blanked = 0
      for item in items when validEntityId(item.id)
        file = E.fileFor a.source, item.id
        continue unless file
        { doc, body: mdBody } = E.readEntityFile file
        changed = false
        for dotPath in (item.fields ? [])
          [component, ...rest] = String(dotPath).split '.'
          field = rest.join '.'
          continue unless component and field
          doc[component] ?= {}
          doc[component][field] = null
          changed = true
          blanked++
        continue unless changed
        E.writeEntityFile file, doc, mdBody
        await store.upsert a.source, item.id, doc, fs.statSync(file).mtimeMs
        persisted 'entity', { source: a.source, id: item.id }
      return json { ok: true, blanked }

    if m = p.match /^\/api\/entity\/(.+)$/
      a = resolveActivity url.searchParams.get('activity')
      id = decodeURIComponent m[1]
      if req.method is 'GET'
        doc = await store.get a.source, id
        return json { id, doc }
      if req.method is 'PATCH'
        body = await req.json()
        file = E.fileFor a.source, id
        return json { error: 'not found' }, 404 unless file
        { doc, body: mdBody } = E.readEntityFile file
        patch = {}
        patch[body.component] = {}
        patch[body.component][body.field] = body.value
        E.mergePatch doc, patch
        E.writeEntityFile file, doc, mdBody
        await store.upsert a.source, id, doc, fs.statSync(file).mtimeMs
        persisted 'entity', { source: a.source, id }
        engine.pump()
        return json { ok: true, doc }
      if req.method is 'DELETE'
        file = E.fileFor a.source, id
        return json { error: 'not found' }, 404 unless file
        engine.stop ({ source: a.source, id, stage } for stage in stages.list())
        fs.rmSync file, force: true
        await store.remove a.source, id
        persisted 'entity', { source: a.source, id }
        return json { ok: true, id }

    if m = p.match /^\/api\/entity\/(.+)\/rename$/
      return json { error: 'rename requires POST' }, 405 unless req.method is 'POST'
      a = resolveActivity url.searchParams.get('activity')
      id = decodeURIComponent m[1]
      body = await req.json()
      nextId = validEntityId body.id
      return json { error: 'invalid entity id' }, 400 unless nextId
      return json { ok: true, id, nextId } if nextId is id
      file = E.fileFor a.source, id
      return json { error: 'not found' }, 404 unless file
      return json { error: 'entity already exists' }, 409 if E.fileFor(a.source, nextId)
      target = path.resolve a.source, nextId + path.extname(file)
      sourceRoot = path.resolve(a.source) + path.sep
      return json { error: 'invalid entity id' }, 400 unless target.startsWith sourceRoot
      { doc } = E.readEntityFile file
      engine.stop ({ source: a.source, id, stage } for stage in stages.list())
      fs.mkdirSync path.dirname(target), recursive: true
      fs.renameSync file, target
      await store.remove a.source, id
      await store.upsert a.source, nextId, doc, fs.statSync(target).mtimeMs
      persisted 'entity', { source: a.source, id }
      persisted 'entity', { source: a.source, id: nextId }
      return json { ok: true, id, nextId, doc }

    if p is '/api/stage/from-prompt' and req.method is 'POST'
      body = await req.json()
      prompt = String(body.prompt ? '').trim()
      return json { error: 'no local stage template matches this prompt' }, 422 unless isFruitEaterPrompt prompt
      a = resolveActivity body.activity
      if body.revision? and Number(body.revision) isnt Number(a.revision ? 0)
        return json { error: 'activity revision conflict', revision: a.revision }, 409
      ci = Number body.column
      return json { error: 'select an empty column first' }, 400 unless Number.isInteger(ci) and a.columns[ci]? and not a.columns[ci].stage? and not a.columns[ci].field?
      slug = 'fruit-eater'
      n = 2
      while stages.exists slug
        slug = "fruit-eater-#{n}"
        n++
      stages.write slug, fruitEaterStage(prompt)
      activities.update a.slug, (doc) ->
        doc.columns ?= []
        doc.columns[ci] = { stage: slug }
        doc.revision = Number(doc.revision ? 0) + 1
      persisted 'stage', { slug }
      persisted 'activity', { slug: a.slug }
      return json {
        ok: true, slug
        summary: "I created the #{slug} stage. It writes animal.name and renders each result as a Wikipedia link."
      }

    if m = p.match /^\/api\/stage\/([\w-]+)\/views\.js$/
      js = stages.js m[1]
      return new Response 'not found', status: 404 unless js?
      return new Response js, headers: { 'content-type': 'text/javascript' }

    if m = p.match /^\/api\/stage\/([\w-]+)$/
      slug = m[1]
      if req.method is 'GET'
        return json { slug, source: stages.source(slug), meta: (try await stages.meta slug catch e then { error: e.message }) }
      if req.method is 'PUT'
        body = await req.json()
        stages.write slug, String(body.source ? '')
        persisted 'stage', { slug }
        return json { ok: true }

    if p is '/api/run' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      cells = ({ source: a.source, id: c.id, stage: c.stage } for c in (body.cells ? []))
      added = engine.enqueue cells
      return json { ok: true, added }

    if p is '/api/run/range' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      ranges = A1.parseRange body.range ? ''
      ids = await orderedIds a
      { cells, skipped } = A1.resolveCells ranges, a.columns, ids
      added = engine.enqueue ({ source: a.source, id: c.id, stage: c.stage } for c in cells)
      return json { ok: true, added, skipped, resolved: cells.length }

    if p is '/api/stop' and req.method is 'POST'
      body = await req.json()
      if body.all then engine.stop()
      else
        a = resolveActivity body.activity
        engine.stop ({ source: a.source, id: c.id, stage: c.stage } for c in (body.cells ? []))
      return json { ok: true }

    if p is '/api/queue'
      if req.method is 'POST' or (p is '/api/queue' and req.method is 'GET')
        return json { snapshot: engine.snapshot(), cells: engine.cellStates() }

    if p is '/api/queue/concurrency' and req.method is 'POST'
      body = await req.json()
      n = engine.setConcurrency body.n
      return json { ok: true, concurrency: n }

    if p is '/api/queue/clear' and req.method is 'POST'
      engine.clear()
      return json { ok: true }

    if p is '/api/dry-run' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      try
        results = await engine.dryRun a.source, body.stage, (body.ids ? [])
        return json { ok: true, results }
      catch err
        return json { ok: false, error: String(err?.message ? err) }, 400

    if p is '/api/resolve-ref' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      ranges = A1.parseRange body.a1 ? ''
      ids = await orderedIds a
      out = []
      for r in ranges
        cols = r.cols ? [0...a.columns.length]
        rows = r.rows ? null
        for ci in cols when ci < a.columns.length
          col = a.columns[ci]
          entry = { col: A1.indexToCol(ci), stage: col.stage ? null, field: col.field ? null }
          entry.ids = (ids[ri] for ri in (rows ? []) when ri < ids.length) if rows?
          out.push entry
      return json { refs: out }

    if p is '/api/activity' and req.method is 'POST'
      slug = activities.create()
      persisted 'activity', { slug }
      return json { ok: true, slug }

    if m = p.match /^\/api\/activity\/([\w-]+)$/
      slug = m[1]
      activity = activities.get slug
      return json { error: "activity not found: #{slug}" }, 404 unless activity
      if req.method is 'DELETE'
        revision = Number url.searchParams.get('revision') if url.searchParams.has 'revision'
        if revision? and revision isnt Number(activity.revision ? 0)
          return json { error: 'activity revision conflict', revision: activity.revision }, 409
        activities.remove slug
        persisted 'activity', { slug }
        return json { ok: true }
      if req.method is 'PATCH'
        body = await req.json()
        if body.revision? and Number(body.revision) isnt Number(activity.revision ? 0)
          return json { error: 'activity revision conflict', revision: activity.revision }, 409
        activities.update slug, (doc) ->
          doc.title = body.title if body.title?
          doc.columns = body.columns if body.columns?
          doc.component_locks = body.componentLocks if body.componentLocks?
          doc.rows = { source: body.source } if body.source?
          doc.revision = Number(doc.revision ? 0) + 1
        # a changed source may need loading
        await loadAll()
        persisted 'activity', { slug }
        return json { ok: true }

    if p is '/api/log'
      return json { lines: engine.logRing.slice -500 }

    # ---- static SPA ----
    fp = if p is '/' then '/index.html' else p
    file = path.join PUBLIC, path.normalize(fp).replace(/^([.\\/])+/, '')
    if file.startsWith(PUBLIC) and fs.existsSync(file) and fs.statSync(file).isFile()
      return new Response Bun.file(file), headers: { 'content-type': MIME[path.extname file] ? 'application/octet-stream' }
    # SPA fallback (hash routing → index)
    return new Response Bun.file(path.join PUBLIC, 'index.html'), headers: { 'content-type': 'text/html' }

  server = Bun.serve
    port: ws.port
    idleTimeout: 120
    fetch: (req) ->
      try
        await handle req
      catch err
        console.error 'sheets server error:', err
        json { error: String(err?.message ? err) }, 500
    websocket:
      open: (sock) ->
        sockets.add sock
        sock.send JSON.stringify engine.snapshot()
        sock.send JSON.stringify { type: 'cells', cells: engine.cellStates() }
      close: (sock) -> sockets.delete sock
      message: (sock, msg) -> null

  CFG.writeServerJson ws, { port: ws.port, pid: process.pid, started: Date.now() }
  cleanup = ->
    CFG.clearServerJson ws
    w.close() for w in watchers
    engine.close()
  process.on 'SIGINT', -> cleanup(); process.exit 0
  process.on 'SIGTERM', -> cleanup(); process.exit 0

  console.log "sheets serving #{ws.root} (db: #{ws.db}) on http://localhost:#{ws.port}"
  { server, ws, store, engine, stages, activities, stop: -> cleanup(); server.stop(true) }
