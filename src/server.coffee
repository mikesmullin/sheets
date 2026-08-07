# The sheets server (§2, §10): owns the files, runs stages, hosts Angela.
# HTTP API + /ws/run NDJSON event fan-out + static SPA + /__m_hmr (m-js-style public HMR).
# Browser and CLI are peer clients.
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

# apple -> apple1, apple2, … (digit suffix until the path is free).
uniqueCopyId = (source, id) ->
  base = String(id ? '').replace /\/+$/, ''
  n = 1
  loop
    candidate = validEntityId "#{base}#{n}"
    return null unless candidate
    return candidate unless E.fileFor source, candidate
    n++

# Prefer meaningful short slugs over the first 40 chars of a long sentence
# ("based-on-the-color-of-the-fruit-and-the-" was useless).
STOP_WORDS = new Set [
  'a','an','the','of','and','or','to','for','in','on','at','by','with','from','as','is','are'
  'be','this','that','it','its','into','than','then','than','while','would','should','could'
  'based','using','use','make','made','does','do','did','will','can','about','what','which'
  'when','where','how','who','whom','their','them','they','you','your','our','my','me','i'
]
promptStageSlug = (prompt, stages) ->
  words = String(prompt ? '').toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter (w) -> w.length > 1 and not STOP_WORDS.has w
  # de-dupe while preserving order
  seen = new Set()
  uniq = []
  for w in words when not seen.has w
    seen.add w
    uniq.push w
  base = (uniq.slice(0, 5).join('-') or 'stage').slice(0, 48).replace(/^-+|-+$/g, '') or 'stage'
  slug = base
  n = 2
  while stages.exists slug
    slug = "#{base}-#{n}"
    n++
  slug

export startServer = (opts = {}) ->
  ws = CFG.resolveWorkspace opts
  locks = CFG.acquireDbLocks ws.dbs, { root: ws.root }
  store = try await new Store(ws, memory: opts.memory).init() catch err
    CFG.releaseDbLocks locks
    throw err
  activities = new Activities ws
  stages = new Stages ws
  engine = new Engine ws, store, stages
  engine.setConcurrency ws.concurrency
  sockets = new Set()
  hmrClients = new Set()
  watchers = []

  broadcast = (ev) ->
    msg = JSON.stringify ev
    sock.send msg for sock from sockets
    null

  # m-js v3 HMR protocol: { type: 'change', path: '/rel' } over ws://host/__m_hmr
  broadcastHmr = (relPath) ->
    rel = String(relPath ? '').replace(/\\/g, '/').replace /^\/+/, ''
    return null unless rel
    payload = JSON.stringify { type: 'change', path: "/#{rel}" }
    n = 0
    for sock from hmrClients
      try
        sock.send payload
        n++
      catch then null
    console.log "[hmr] #{rel} → #{n} client(s)"
    null

  persisted = (resource, data = {}) ->
    ev = { type: 'persisted', resource }
    ev[key] = value for key, value of data
    broadcast ev
    null

  # Shared by fs.watch + Angela file_io writes (chat) so SPA always reloads stage views.
  notifyStageWritten = (slug) ->
    return unless slug
    stages.invalidate slug
    console.log "sheets: stage updated #{slug}"
    persisted 'stage', { slug }
    null

  chat = createChatApi ws, {
    stages, activities, store, engine
    onStageWritten: notifyStageWritten
  }

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
    # Editors / tools that write outside chat still land here.
    return unless fname?
    base = path.basename String(fname)
    return unless base.endsWith '.coffee'
    slug = base.replace /\.coffee$/, ''
    return unless slug
    debounce "stage:#{slug}", 120, -> notifyStageWritten slug

  # Browser-safe shared stage libraries (views.mjs, cell.mjs, k8-links.mjs)
  # must also prompt view-module reloads. Server-only library changes still need
  # a server restart because Bun caches their dynamic imports.
  watchSafe path.join(ws.sheetsDir, 'lib'), (event, fname) ->
    return unless fname? and String(fname).endsWith '.mjs'
    debounce "stage-lib:#{fname}", 120, ->
      stages.invalidate slug for slug in stages.list()
      console.log "sheets: stage view library updated #{fname}"
      persisted 'stage', { slug } for slug in stages.list()

  activitySources = new Map()
  watchSafe ws.activitiesDir, (event, fname) ->
    return unless fname?.match /\.ya?ml$/
    slug = fname.replace /\.ya?ml$/, ''
    debounce "activity:#{slug}", 150, ->
      current = activities.get slug
      source = current?.source ? null
      changedSource = activitySources.get(slug) isnt source
      activitySources.set slug, source
      await loadAll() if changedSource
      persisted 'activity', { slug, revision: current?.revision }

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

  # SPA asset HMR (m-js hot-client): watch public/ and push path changes
  watchSafe PUBLIC, (event, fname) ->
    return unless fname?
    ext = path.extname(fname).toLowerCase()
    return unless ext in ['.js', '.mjs', '.css', '.html']
    rel = String(fname).replace /\\/g, '/'
    debounce "hmr:#{rel}", 50, -> broadcastHmr rel

  # load every activity source into the PGLite mirror
  loadAll = ->
    dirs = new Set(a.source for a in activities.list())
    dirs.add d for d in (ws.dbs ? [ws.db])
    for dir from dirs when fs.existsSync dir
      n = await store.loadSource dir, onProgress: (progress) ->
        console.log "sheets: importing #{progress.completed}/#{progress.total} entities from #{dir}" if progress.completed is progress.total or progress.completed % 100 is 0
      watchSource dir
      console.log "sheets: loaded #{n} entities from #{dir}"
    activitySources.clear()
    activitySources.set a.slug, a.source for a in activities.list()
    null
  try
    await loadAll()
  catch err
    await store.close()
    CFG.releaseDbLocks locks
    throw err

  resolveActivity = (slug) ->
    a = activities.get slug
    a ? (activities.list()[0] ? { slug: null, source: ws.db, columns: [] })

  # Grid / A1 indices use visible columns only; activity YAML keeps full order + hidden.
  visibleColumns = (cols) -> (c for c in (cols ? []) when not c.hidden)
  fullIndexFromVisible = (cols, vi) ->
    v = 0
    for c, i in (cols ? [])
      continue if c.hidden
      return i if v is vi
      v++
    -1

  displayCache = new Map()
  displayFields = (source) ->
    unless displayCache.has source
      displayCache.set source, E.displayFieldsFor source
    displayCache.get source

  # Flatten a cell value for user sort/filter (string compare / regex).
  cellText = (doc, dotPath) ->
    return '' unless dotPath
    v = E.getPath doc, dotPath
    return '' if v is undefined or v is null
    return JSON.stringify v if typeof v is 'object'
    String v

  # User column sort/filter always keys off a field path. Stage modules may expose
  # sort() as a default only when the user has not chosen A–Z / Z–A themselves.
  resolveWritesPath = (stageSlug) ->
    return null unless stageSlug
    meta = try await stages.meta stageSlug catch then null
    return null if meta?.error?
    w = meta?.writes
    return null unless Array.isArray(w) and w.length
    String w[0]

  compileFilter = (pattern) ->
    text = String(pattern ? '')
    return null unless text.length
    try
      new RegExp text
    catch
      # Invalid regex matches nothing (client should also surface the error).
      { test: -> false }

  # True if entity id or any leaf component-field value (stringified) matches re.
  entityMatchesSearch = (row, re) ->
    return true if re.test String(row.id ? '')
    walk = (v) ->
      return false unless v?
      if Array.isArray v
        return v.some walk
      if typeof v is 'object'
        return (Object.values v).some walk
      re.test String v
    walk row.doc ? {}

  compareCellText = (a, b, dir = 'asc') ->
    sa = String(a ? '')
    sb = String(b ? '')
    na = Number sa
    nb = Number sb
    if sa isnt '' and sb isnt '' and Number.isFinite(na) and Number.isFinite(nb) and String(na) is sa.trim() and String(nb) is sb.trim()
      cmp = if na < nb then -1 else if na > nb then 1 else 0
    else
      cmp = sa.localeCompare sb, undefined, { numeric: true, sensitivity: 'base' }
    if dir is 'desc' then -cmp else cmp

  # Load / filter / sort the full activity source, then window. User sortPath and
  # column filters take precedence over a stage's optional sort() comparator.
  queryEntities = (activity, opts = {}) ->
    q = opts.q or null
    # Load full set without SQL ILIKE — global search is regex over field values.
    # Bounded-batch read (Store#allRows): a single huge-LIMIT query can crash PGlite's
    # WASM heap and permanently wedge the connection for all later requests.
    rows = await store.allRows activity.source
    if q
      re = compileFilter q
      if re?
        rows = rows.filter (row) -> entityMatchesSearch row, re
    filters = opts.filters ? []
    if filters.length
      # Stage columns filter on views.text — the plain-text form of what the operator
      # actually sees — so a derived state like "BLOCKED" matches even when it is not
      # a stored field. Modules are loaded once per query, not per row.
      textFns = {}
      for f in filters when f.stage
        unless textFns[f.stage]?
          mod = try await stages.load f.stage catch then null
          textFns[f.stage] = mod?.views?.text ? null
      rows = rows.filter (row) ->
        filters.every (f) ->
          re = compileFilter f.re
          return true unless re?
          fn = if f.stage then textFns[f.stage] else null
          # Nothing to test against — pass, and do not let NOT invert that into
          # a filter that hides every row.
          return true unless fn? or f.path
          hit =
            if fn?
              value = try fn row.doc catch then ''
              re.test String(value ? '')
            else
              re.test cellText row.doc, f.path
          if f.not then not hit else hit
    sortPath = opts.sortPath or opts.sortField or null
    dir = opts.dir ? 'asc'
    if sortPath
      # Explicit user (or field) sort — never defer to stage.sort.
      rows = rows.slice().sort (x, y) ->
        cmp = compareCellText cellText(x.doc, sortPath), cellText(y.doc, sortPath), dir
        return cmp if cmp isnt 0
        String(x.id).localeCompare String(y.id)
    else if opts.sortStage
      # Stage default sort only when the user has not chosen a value path.
      stageSlug = opts.sortStage
      mod = try await stages.load stageSlug catch then null
      if mod?.sort?
        rows = rows.slice().sort (x, y) ->
          cmp = mod.sort x.doc, y.doc
          cmp = -cmp if dir is 'desc'
          return cmp if cmp isnt 0
          String(x.id).localeCompare String(y.id)
      else
        writePath = await resolveWritesPath stageSlug
        if writePath
          rows = rows.slice().sort (x, y) ->
            cmp = compareCellText cellText(x.doc, writePath), cellText(y.doc, writePath), dir
            return cmp if cmp isnt 0
            String(x.id).localeCompare String(y.id)
        else if dir is 'desc'
          rows = rows.slice().reverse()
    else if dir is 'desc'
      rows = rows.slice().reverse()
    total = rows.length
    offset = Math.max 0, opts.offset | 0
    limit = Math.max 0, opts.limit | 0
    { total, offset, rows: rows.slice(offset, offset + limit) }

  # order ids for a source per sort spec (run/range and other callers)
  orderedIds = (activity, sort = null) ->
    result = await queryEntities activity, {
      sortPath: sort?.field ? null
      sortStage: sort?.stage ? null
      dir: sort?.dir ? 'asc'
    }
    (r.id for r in result.rows)

  handle = (req) ->
    url = new URL req.url
    p = url.pathname

    # ---- websocket upgrade ----
    if p is '/ws/run'
      return undefined if server.upgrade req, data: { kind: 'run' }
      return new Response 'upgrade failed', status: 400
    if p is '/__m_hmr'
      return undefined if server.upgrade req, data: { kind: 'hmr' }
      return new Response 'upgrade failed', status: 400
    if p is '/__m_health'
      return json { ok: true, hmrClients: hmrClients.size, runClients: sockets.size }

    # ---- chat (angela) ----
    if p.startsWith '/api/chat'
      r = await chat.handle req, url
      return r if r?

    if p is '/speak' and req.method is 'GET'
      text = String(url.searchParams.get('text') ? '').slice 0, 4000
      return json { error: 'no text' }, 400 unless text.trim()
      return json { error: 'ada_not_installed' }, 501 unless Bun.which 'ada'
      try
        Bun.spawn ['ada', 'voice', text], stdout: 'ignore', stderr: 'ignore'
        return json { ok: true }
      catch err
        return json { error: "ada_failed: #{err.message}" }, 500

    # ---- api ----
    if p is '/api/meta'
      acts = activities.list()
      return json {
        root: ws.root, db: ws.db, dbs: (ws.dbs ? [ws.db]), port: ws.port
        model: ws.model, chat: chat.enabled()
        import: store.importStatus()
        activities: ({ slug: a.slug, title: a.title, source: a.source, columns: a.columns, componentLocks: a.componentLocks, revision: a.revision } for a in acts)
      }

    if p is '/api/import'
      return json store.importStatus()

    if p is '/api/stages'
      out = []
      for slug in stages.list()
        meta = try await stages.meta slug catch then null
        out.push { slug, title: meta?.title ? slug }
      return json { stages: out }

    if p is '/api/entities' and req.method is 'GET'
      a = resolveActivity url.searchParams.get('activity')
      sortStage = url.searchParams.get 'sortStage'
      # sortPath is the preferred user-driven key; sortField kept as alias.
      sortPath = url.searchParams.get('sortPath') or url.searchParams.get('sortField') or null
      sortField = url.searchParams.get 'sortField'
      dir = url.searchParams.get('dir') ? 'asc'
      offset = Number(url.searchParams.get('offset') ? 0)
      rawLimit = Number(url.searchParams.get('limit') or 100)
      limit = Math.max 1, Math.min 500, (if Number.isFinite(rawLimit) and rawLimit > 0 then rawLimit else 100)
      q = url.searchParams.get('q') or null
      filterPaths = url.searchParams.getAll 'filterPath'
      filterRes = url.searchParams.getAll 'filterRe'
      filterStages = url.searchParams.getAll 'filterStage'
      filterNots = url.searchParams.getAll 'filterNot'
      filters = []
      for re, i in filterRes
        fpath = filterPaths[i] ? ''
        fstage = filterStages[i] ? ''
        continue unless fpath or fstage
        filters.push { path: fpath, re: re ? '', stage: fstage, not: String(filterNots[i] ? '') is '1' }
      # Always go through queryEntities so reads use store.allRows (bounded 200-row batches)
      # and avoid PGlite WASM memory overflow ("out of bounds memory access") on large offset queries.
      result = await queryEntities a, {
        offset, limit, q, dir
        sortPath: sortPath or sortField or null
        sortStage: if sortPath or sortField then null else sortStage
        filters
      }
      total = result.total
      offset = result.offset
      rows = result.rows
      df = displayFields a.source
      rows = for r in rows
        file = E.fileFor a.source, r.id
        {
          id: r.id
          doc: r.doc
          label: E.labelFor r.id, r.doc, df
          file: file ? null
        }
      return json { total, offset, rows }

    if p is '/api/fields'
      a = resolveActivity url.searchParams.get('activity')
      discovered = await store.fieldPaths a.source
      schemaGroups = E.componentFieldsFor a.source
      # Union schema + discovered fields; alphabetically ordered; mark inSchema.
      byComp = new Map()
      for group in schemaGroups
        set = byComp.get(group.component) ? new Set()
        set.add name for name in group.fields
        byComp.set group.component, set
      for field in discovered
        [component, ...rest] = field.split '.'
        continue unless component and rest.length
        name = rest.join '.'
        set = byComp.get(component) ? new Set()
        set.add name
        byComp.set component, set
      components = []
      for component in Array.from(byComp.keys()).sort()
        names = Array.from(byComp.get(component)).sort()
        fields = for name in names
          {
            name
            path: "#{component}.#{name}"
            inSchema: E.schemaHasField a.source, component, name
          }
        components.push { component, fields }
      return json {
        fields: discovered
        components
        schema: schemaGroups.length > 0
      }

    # Toggle a field in schema.yaml (add with guessed type, or remove).
    if p is '/api/fields/schema' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      pathDot = String(body.field ? '')
      [component, ...rest] = pathDot.split '.'
      field = rest.join '.'
      return json { error: 'field must be component.field' }, 400 unless component and field
      action = String(body.action ? '')
      return json { error: "action must be 'add' or 'remove'" }, 400 unless action in ['add', 'remove']
      type = 'string'
      if action is 'add'
        samples = await store.fieldSamples a.source, component, field
        type = E.guessFieldType samples
      try
        result = E.mutateSchemaField a.source, component, field, action, type
      catch err
        return json { error: String(err?.message ? err) }, 400
      persisted 'schema', { source: a.source }
      return json { ok: true, ...result }

    # Delete component.field from every entity file in the activity source.
    if p is '/api/fields/delete' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      pathDot = String(body.field ? '')
      [component, ...rest] = pathDot.split '.'
      field = rest.join '.'
      return json { error: 'field must be component.field' }, 400 unless component and field
      changed = E.deleteFieldFromAll a.source, component, field
      # Refresh store for all changed entities (reload source is simplest).
      await store.loadSource a.source
      persisted 'entity', { source: a.source, id: '*' }
      return json { ok: true, field: pathDot, changed }

    # Delete a stage .coffee from disk and drop it from all activity columns.
    if p is '/api/stage/delete' and req.method is 'POST'
      body = await req.json()
      slug = String(body.slug ? body.stage ? '').trim()
      return json { error: 'stage slug required' }, 400 unless slug
      return json { error: "stage not found: #{slug}" }, 404 unless stages.exists slug
      stages.remove slug
      # Strip from every activity column list.
      for act in activities.list()
        has = (act.columns ? []).some (c) -> c.stage is slug
        continue unless has
        activities.update act.slug, (doc) ->
          doc.columns = (c for c in (doc.columns ? []) when c.stage isnt slug)
          doc.revision = Number(doc.revision ? 0) + 1
        persisted 'activity', { slug: act.slug }
      persisted 'stage', { slug }
      return json { ok: true, slug }

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

    # Duplicate selected entities: copy YAML (and .md body) to a free id with a digit suffix.
    if p is '/api/entities/duplicate' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      # Preserve request order (selection order); de-dupe while keeping first occurrence.
      seen = new Set()
      ids = []
      for raw in (body.ids ? [])
        id = validEntityId raw
        continue unless id
        continue if seen.has id
        seen.add id
        ids.push id
      return json { error: 'no valid entity ids supplied' }, 400 unless ids.length
      created = []
      for id in ids
        file = E.fileFor a.source, id
        return json { error: "not found: #{id}" }, 404 unless file
        nextId = uniqueCopyId a.source, id
        return json { error: "could not allocate unique id for #{id}" }, 500 unless nextId
        { doc, body: mdBody } = E.readEntityFile file
        copy = structuredClone doc
        ext = path.extname file
        target = path.join a.source, nextId + ext
        sourceRoot = path.resolve(a.source) + path.sep
        return json { error: 'invalid entity id' }, 400 unless path.resolve(target).startsWith(sourceRoot) or path.resolve(target) is path.resolve(a.source)
        # nested class ids may need parent dirs
        fs.mkdirSync path.dirname(target), recursive: true
        E.writeEntityFile target, copy, mdBody
        await store.upsert a.source, nextId, copy, fs.statSync(target).mtimeMs
        persisted 'entity', { source: a.source, id: nextId }
        created.push { id: nextId, from: id, file: target }
      return json { ok: true, created }

    # DELETE-key clear: stage-aware. Field cells: deleteAtPath. Stage cells: call stage `clear` if exported, else delete writes[0].
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
        if item.stage
          try
            mod = await stages.load item.stage
            handler = mod?.clear ? mod?.onDelete ? null
            # also support bracket access for `delete` keyword via JS
            unless handler
              try handler = mod?['delete'] catch then handler = null
            if typeof handler is 'function'
              patch = await handler structuredClone(doc)
              if patch? and typeof patch is 'object' and not Array.isArray(patch) and Object.keys(patch).length
                E.mergePatch doc, patch
                changed = true
                blanked++
            else
              dotPath = mod?.meta?.writes?[0]
              if dotPath and String(dotPath).includes '.'
                if E.deleteAtPath doc, dotPath
                  changed = true
                  blanked++
          catch err
            try
              mod2 = try await stages.load item.stage catch then null
              dotPath2 = mod2?.meta?.writes?[0]
              if dotPath2 and E.deleteAtPath doc, dotPath2
                changed = true
                blanked++
            catch then null
        for dotPath in (item.fields ? [])
          continue unless String(dotPath ? '').includes '.'
          if E.deleteAtPath doc, dotPath
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
        if body.patch?
          return json { error: 'patch must be an object' }, 400 unless typeof body.patch is 'object' and not Array.isArray body.patch
          E.mergePatch doc, body.patch
          E.writeEntityFile file, doc, mdBody
          await store.upsert a.source, id, doc, fs.statSync(file).mtimeMs
          persisted 'entity', { source: a.source, id }
          engine.pump()
          return json { ok: true, doc }
        component = String(body.component ? '').trim()
        field = String(body.field ? '')
        return json { error: 'component required' }, 400 unless component
        patch = {}
        patch[component] = {}
        # body.field may be nested under the component (e.g. destination.permanent_space).
        if field then patch[component][field] = body.value else patch[component] = body.value
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
      return json { error: 'prompt is required' }, 400 unless prompt
      a = resolveActivity body.activity
      if body.revision? and Number(body.revision) isnt Number(a.revision ? 0)
        return json { error: 'activity revision conflict', revision: a.revision }, 409
      # Prefer fullColumn (index into activity YAML including hidden). Fall back to
      # mapping visible `column` → full index — required when hidden field columns exist.
      fi = if body.fullColumn? and Number.isFinite(Number body.fullColumn)
        Math.trunc Number body.fullColumn
      else
        fullIndexFromVisible a.columns, Number(body.column)
      col = if fi >= 0 and fi < (a.columns?.length ? 0) then a.columns[fi] else null
      isEmptyCol = (c) -> c? and not c.stage and not c.field
      unless isEmptyCol col
        return json {
          error: if col?.stage or col?.field
            "column is not empty (has #{if col.stage then 'stage' else 'field'})"
          else
            'select an empty column first'
        }, 400
      slug = promptStageSlug prompt, stages
      activities.update a.slug, (doc) ->
        doc.columns ?= []
        prev = doc.columns[fi] ? {}
        next = { stage: slug }
        next.width = prev.width if prev.width?
        # Authoring a stage always shows the column.
        doc.columns[fi] = next
        doc.revision = Number(doc.revision ? 0) + 1
      persisted 'activity', { slug: a.slug }
      return json { ok: true, slug, authored: false }

    # Facet counts for one column, computed from the same text a filter matches
    # against (stage views.text, else the field value) so the checkbox list and the
    # regex box can never disagree about what a cell "says".
    if p is '/api/column/values' and req.method is 'GET'
      a = resolveActivity url.searchParams.get('activity')
      stageSlug = url.searchParams.get('stage') or ''
      fpath = url.searchParams.get('path') or ''
      limit = Math.max 1, Math.min 50, Number(url.searchParams.get('limit') ? 12)
      textFn = null
      if stageSlug
        mod = try await stages.load stageSlug catch then null
        textFn = mod?.views?.text ? null
      return json { values: [], sampled: 0, distinct: 0, total: 0 } unless textFn? or fpath
      rows = await store.allRows a.source
      counts = new Map()
      sampled = 0
      for row in rows
        value = if textFn?
          try String(textFn(row.doc) ? '') catch then ''
        else
          cellText row.doc, fpath
        value = String(value ? '').trim()
        continue unless value
        sampled += 1
        counts.set value, (counts.get(value) ? 0) + 1
      values = Array.from counts, ([value, count]) -> { value, count }
      values.sort (x, y) -> (y.count - x.count) or x.value.localeCompare y.value
      return json {
        total: rows.length
        sampled
        distinct: values.length
        values: values.slice 0, limit
      }

    # Stage RPC: an explicit, user-triggered stage command outside the run queue.
    # A stage may export rpc(entity, method, ctx) and return { patch, message }.
    if p is '/api/rpc' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      id = validEntityId body.id
      stage = String(body.stage ? '').trim()
      method = String(body.method ? '').trim()
      return json { error: 'valid entity id required' }, 400 unless id
      return json { error: 'stage required' }, 400 unless stage
      return json { error: 'RPC method required' }, 400 unless method
      return json { error: "stage not in activity: #{stage}" }, 403 unless (a.columns ? []).some (c) -> c.stage is stage
      file = E.fileFor a.source, id
      return json { error: 'not found' }, 404 unless file
      try
        mod = await stages.load stage
      catch err
        return json { error: String(err?.message ? err) }, 400
      return json { error: "stage has no RPC handler: #{stage}" }, 404 unless typeof mod?.rpc is 'function'
      { doc, body: mdBody } = E.readEntityFile file
      log = (line) -> console.log "rpc #{stage}/#{method} #{id}: #{String(line ? '').slice(0, 500)}"
      try
        result = await mod.rpc doc, method, {
          entityId: id, activity: a.slug, source: a.source, args: body.args ? null, signal: req.signal, log
        }
      catch err
        return json { error: String(err?.message ? err) }, 500
      result = {} unless result? and typeof result is 'object'
      patch = result.patch ? null
      if patch?
        return json { error: 'RPC patch must be an object' }, 500 unless typeof patch is 'object' and not Array.isArray patch
        E.mergePatch doc, patch
        E.writeEntityFile file, doc, mdBody
        await store.upsert a.source, id, doc, fs.statSync(file).mtimeMs
        persisted 'entity', { source: a.source, id }
      return json { ok: true, doc, message: result.message ? null, result: result.result ? null }

    # Stage modules are served at real URLs that mirror the on-disk layout, so the
    # browser's module loader resolves `../lib/*.mjs` natively (no blob/data URLs).
    if m = p.match /^\/stagemod\/lib\/([\w.-]+)$/
      libFile = path.join ws.sheetsDir, 'lib', m[1]
      return new Response 'not found', status: 404 unless fs.existsSync libFile
      return new Response fs.readFileSync(libFile, 'utf8'),
        headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }

    if m = p.match /^\/stagemod\/stages\/([\w-]+)\.mjs$/
      js = stages.js m[1]
      return new Response 'not found', status: 404 unless js?
      # Stamp lib imports with the newest lib mtime so edits hot-reload without
      # a hard refresh (the specifier itself is fixed in stage source).
      libDir = path.join ws.sheetsDir, 'lib'
      v = 0
      if fs.existsSync libDir
        for f in fs.readdirSync libDir
          try
            mt = fs.statSync(path.join libDir, f).mtimeMs
            v = mt if mt > v
      js = js.replace /(from\s+['"]\.\.\/lib\/[\w.-]+\.mjs)(['"])/g, "$1?v=#{Math.round v}$2"
      return new Response js,
        headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }

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
        notifyStageWritten slug
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
      { cells, skipped } = A1.resolveCells ranges, visibleColumns(a.columns), ids
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
      # Persist as the new startup value so a restart keeps the operator's setting.
      # Surgical line edit (not yaml.dump) so comments in config.yaml survive.
      try
        raw = if fs.existsSync ws.cfgPath then fs.readFileSync(ws.cfgPath, 'utf8') else ''
        if /^concurrency:.*$/m.test raw
          raw = raw.replace /^concurrency:.*$/m, "concurrency: #{n}"
        else
          raw = (if raw and not /\n$/.test raw then raw + '\n' else raw) + "concurrency: #{n}\n"
        fs.writeFileSync ws.cfgPath, raw
      catch err
        console.error 'sheets: could not persist concurrency:', err.message
      return json { ok: true, concurrency: n }

    if p is '/api/queue/clear' and req.method is 'POST'
      engine.clear()
      return json { ok: true }

    if p is '/api/dry-run' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      try
        results = await engine.dryRun a.source, body.stage, (body.ids ? []), { signal: req.signal }
        return json { ok: true, results }
      catch err
        return json { ok: false, error: String(err?.message ? err) }, 400

    if p is '/api/resolve-ref' and req.method is 'POST'
      body = await req.json()
      a = resolveActivity body.activity
      ranges = A1.parseRange body.a1 ? ''
      ids = await orderedIds a
      vcols = visibleColumns a.columns
      out = []
      for r in ranges
        cols = r.cols ? [0...vcols.length]
        rows = r.rows ? null
        for ci in cols when ci < vcols.length
          col = vcols[ci]
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
        updated = activities.update slug, (doc) ->
          doc.title = body.title if body.title?
          doc.columns = body.columns if body.columns?
          doc.component_locks = body.componentLocks if body.componentLocks?
          doc.rows = { source: body.source } if body.source?
          doc.revision = Number(doc.revision ? 0) + 1
        sourceChanged = body.source? and path.resolve(activity.source) isnt path.resolve(updated.rows.source)
        await loadAll() if sourceChanged
        activitySources.set slug, activities.get(slug)?.source ? null
        persisted 'activity', { slug, revision: updated.revision }
        return json { ok: true, revision: updated.revision }

    if p is '/api/log'
      return json { lines: engine.logRing.slice -500 }

    # ---- static SPA ----
    fp = if p is '/' then '/index.html' else p
    file = path.join PUBLIC, path.normalize(fp).replace(/^([.\/])+/, '')
    if file.startsWith(PUBLIC) and fs.existsSync(file) and fs.statSync(file).isFile()
      ext = path.extname file
      headers =
        'content-type': MIME[ext] ? 'application/octet-stream'
        # Dev-friendly: avoid sticky ES module / CSS caches during HMR
        'cache-control': 'no-store'
      return new Response Bun.file(file), { headers }
    # SPA fallback (hash routing → index)
    return new Response Bun.file(path.join PUBLIC, 'index.html'), headers: {
      'content-type': 'text/html'
      'cache-control': 'no-store'
    }

  try
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
          if sock.data?.kind is 'hmr'
            hmrClients.add sock
            sock.send JSON.stringify { type: 'connected', version: 'sheets-hmr' }
            return
          sockets.add sock
          sock.send JSON.stringify engine.snapshot()
          sock.send JSON.stringify { type: 'cells', cells: engine.cellStates() }
        close: (sock) ->
          if sock.data?.kind is 'hmr' then hmrClients.delete sock
          else sockets.delete sock
        message: (sock, msg) -> null
  catch err
    await store.close()
    CFG.releaseDbLocks locks
    throw err

  CFG.writeServerJson ws, { port: ws.port, pid: process.pid, started: Date.now() }
  cleanup = ->
    CFG.clearServerJson ws
    w.close() for w in watchers
    engine.close()
    CFG.releaseDbLocks locks
  process.on 'SIGINT', -> cleanup(); process.exit 0
  process.on 'SIGTERM', -> cleanup(); process.exit 0

  dbLabel = if (ws.dbs ? []).length > 1 then "dbs: #{ws.dbs.join ', '}" else "db: #{ws.db}"
  console.log "sheets serving #{ws.root} (#{dbLabel}) on http://localhost:#{ws.port}"
  for a in activities.list()
    console.log "  tab #{a.slug}  ←  #{a.source}"
  console.log "sheets HMR ws://localhost:#{ws.port}/__m_hmr (watching public/)"
  { server, ws, store, engine, stages, activities, stop: -> cleanup(); server.stop(true) }
