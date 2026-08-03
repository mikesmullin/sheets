# PGLite mirror of every activity's source db (§2). YAML on disk is authoritative;
# this is the v1 query layer: windowing, sort, search via jsonb + expression indexes.
# Indexes come exclusively from .sheets/config.yaml `indexes:` (no auto-indexing).
import path from 'node:path'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import * as E from './entities.coffee'

sanitizePath = (p) ->
  return null unless /^[\w.-]+(\.[\w.-]+)*$/.test String(p)
  String p

pgPathFor = (dotPath) -> '{' + dotPath.split('.').join(',') + '}'

export class Store
  constructor: (@ws, opts = {}) ->
    @db = null
    @sources = new Set()
    @memory = opts.memory ? false
    @import = { state: 'idle', source: null, completed: 0, total: 0, startedAt: null, finishedAt: null, error: null }

  init: ->
    dataDir = if @memory then undefined else @ws.pgdataDir
    fs.mkdirSync @ws.pgdataDir, recursive: true unless @memory
    @db = await PGlite.create (if dataDir then { dataDir } else {})
    await @db.exec """
      CREATE TABLE IF NOT EXISTS entities (
        source text NOT NULL,
        id text NOT NULL,
        doc jsonb NOT NULL DEFAULT '{}',
        mtime double precision NOT NULL DEFAULT 0,
        PRIMARY KEY (source, id)
      );
    """
    await @ensureIndexes()
    this

  ensureIndexes: ->
    for p in (@ws.indexes ? [])
      dot = sanitizePath p
      continue unless dot
      name = 'idx_' + dot.replace(/[^a-zA-Z0-9]+/g, '_')
      await @db.exec "CREATE INDEX IF NOT EXISTS #{name} ON entities ((doc #>> '#{pgPathFor dot}'));"
    null

  # full (re)load of a source dir from disk
  importStatus: -> { ...@import }

  loadSource: (dir, opts = {}) ->
    dir = path.resolve dir
    @sources.add dir
    files = E.walkDb dir
    @import = {
      state: 'running', source: dir, completed: 0, total: files.length
      startedAt: new Date().toISOString(), finishedAt: null, error: null
    }
    try
      await @db.query "DELETE FROM entities WHERE source = $1", [dir]
      n = 0
      for file in files
        { doc } = E.readEntityFile file
        await @upsert dir, E.idFor(dir, file), doc, fs.statSync(file).mtimeMs
        n++
        @import.completed = n
        opts.onProgress? @importStatus() if n is files.length or n % 100 is 0
      @import.state = 'complete'
      @import.finishedAt = new Date().toISOString()
      opts.onProgress? @importStatus()
      n
    catch err
      @import.state = 'error'
      @import.error = String(err?.message ? err)
      @import.finishedAt = new Date().toISOString()
      opts.onProgress? @importStatus()
      throw err

  refreshFile: (dir, file) ->
    dir = path.resolve dir
    id = E.idFor dir, file
    if fs.existsSync file
      { doc } = E.readEntityFile file
      await @upsert dir, id, doc, fs.statSync(file).mtimeMs
      { id, doc }
    else
      await @remove dir, id
      { id, doc: null }

  upsert: (source, id, doc, mtime = Date.now()) ->
    await @db.query """
      INSERT INTO entities (source, id, doc, mtime) VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT (source, id) DO UPDATE SET doc = $3::jsonb, mtime = $4
    """, [source, id, JSON.stringify(doc), mtime]

  remove: (source, id) ->
    await @db.query "DELETE FROM entities WHERE source = $1 AND id = $2", [source, id]

  count: (source, q = null) ->
    params = [source]
    where = "source = $1"
    if q
      params.push "%#{q}%"
      where += " AND doc::text ILIKE $#{params.length}"
    r = await @db.query "SELECT count(*)::int AS n FROM entities WHERE #{where}", params
    r.rows[0].n

  get: (source, id) ->
    r = await @db.query "SELECT doc FROM entities WHERE source = $1 AND id = $2", [source, id]
    r.rows[0]?.doc ? null

  # Hard ceiling on any single-query row fetch that returns full `doc` JSONB.
  # A single large result set of JSONB docs can exhaust PGlite's WASM heap and
  # permanently wedge the connection — every caller that needs "all rows" must
  # go through a batched method (Store#allRows / Store#fieldPaths / Store#fieldSamples)
  # instead of raising this ceiling.
  MAX_SINGLE_QUERY_ROWS = 500

  window: (source, { offset = 0, limit = 100, orderPath = null, dir = 'asc', q = null } = {}) ->
    dirSql = if String(dir) is 'desc' then 'DESC' else 'ASC'
    params = [source]
    where = "source = $1"
    if q
      params.push "%#{q}%"
      where += " AND doc::text ILIKE $#{params.length}"
    order = "id #{dirSql}"
    if dot = sanitizePath orderPath
      order = "doc #>> '#{pgPathFor dot}' #{dirSql} NULLS LAST, id ASC"
    params.push Math.min(MAX_SINGLE_QUERY_ROWS, Math.max(0, limit | 0))
    params.push Math.max(0, offset | 0)
    r = await @db.query """
      SELECT id, doc FROM entities WHERE #{where}
      ORDER BY #{order} LIMIT $#{params.length - 1} OFFSET $#{params.length}
    """, params
    r.rows

  allIds: (source, dir = 'asc') ->
    dirSql = if String(dir) is 'desc' then 'DESC' else 'ASC'
    r = await @db.query "SELECT id FROM entities WHERE source = $1 ORDER BY id #{dirSql}", [source]
    (row.id for row in r.rows)

  # Full row set (id + doc) for a source, read in bounded batches. Callers that need
  # every row (JS-side filter/sort/search over the whole activity) must go through
  # this instead of a single large-LIMIT query — materializing ~1000+ JSONB docs in
  # one PGlite result can exhaust the WASM heap ("out of bounds memory access") and
  # permanently wedge the connection (every later query on it then fails the same way).
  allRows: (source, batchSize = 200) ->
    out = []
    offset = 0
    loop
      r = await @db.query "SELECT id, doc FROM entities WHERE source = $1 ORDER BY id LIMIT $2 OFFSET $3", [source, batchSize, offset]
      break unless r.rows.length
      out.push row for row in r.rows
      offset += r.rows.length
      break if r.rows.length < batchSize
    out

  # union of component.field dot-paths across docs (column picker).
  # Read in bounded batches: materializing a large JSONB result can exhaust PGlite's WASM heap.
  fieldPaths: (source, sample = 100000, batchSize = 100) ->
    seen = new Set()
    offset = 0
    while offset < sample
      limit = Math.min batchSize, sample - offset
      r = await @db.query "SELECT doc FROM entities WHERE source = $1 ORDER BY id LIMIT $2 OFFSET $3", [source, limit, offset]
      break unless r.rows.length
      for row in r.rows
        for comp, fields of (row.doc ? {})
          if fields? and typeof fields is 'object' and not Array.isArray fields
            seen.add "#{comp}.#{k}" for k of fields
          else
            seen.add comp
      offset += r.rows.length
    Array.from(seen).sort()

  # Collect non-null sample values for component.field (type guessing).
  # Read in bounded batches — same rationale as fieldPaths/allRows above.
  fieldSamples: (source, component, field, sample = 200, batchSize = 100) ->
    out = []
    offset = 0
    while offset < sample
      limit = Math.min batchSize, sample - offset
      r = await @db.query "SELECT doc FROM entities WHERE source = $1 ORDER BY id LIMIT $2 OFFSET $3", [source, limit, offset]
      break unless r.rows.length
      for row in r.rows
        v = row.doc?[component]?[field]
        out.push v if v?
      offset += r.rows.length
    out

  close: -> await @db?.close()
