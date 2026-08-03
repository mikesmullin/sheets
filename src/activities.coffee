# Activities = worksheet tabs: named, ordered column lists, each with its own rows.source —
# one sheets process manages many databases (§3). Columns: {field: 'comp.field'} (default
# stage, not playable) or {stage: '<slug>'} (scripted stage in .sheets/stages/).
# Optional per-column `width` (px) is UI layout only and round-trips through activity YAML.
# Optional `hidden: true` keeps the column in order while omitting it from the grid —
# so show/hide (all|none, checkboxes) does not scramble ordering.
#
# Multi --db: each path is scanned for activities (.sheets/activities under the path or its
# parent project). If none are found, the path itself becomes one synthetic tab (entity db).
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

slugify = (s) ->
  String(s ? 'sheet').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) or 'sheet'

# Load activity YAML files from an activities directory; resolve rows.source against `root`.
loadActivityDir = (actDir, root, defaultSource) ->
  return [] unless fs.existsSync actDir
  out = []
  for f in fs.readdirSync(actDir).sort() when /\.ya?ml$/.test f
    slug = f.replace /\.ya?ml$/, ''
    file = path.join actDir, f
    try
      doc = yaml.load(fs.readFileSync(file, 'utf8')) ? {}
    catch
      continue
    sourceRaw = doc.rows?.source ? defaultSource ? root
    source = if path.isAbsolute(String sourceRaw)
      path.resolve String sourceRaw
    else
      path.resolve root, String sourceRaw
    out.push {
      slug
      title: doc.title ? slug
      source
      columns: doc.columns ? []
      componentLocks: doc.component_locks ? {}
      revision: Number(doc.revision ? 0)
      file
      root
    }
  out

# Scan one --db path for activities to surface as workbook tabs.
export scanDbPath = (dbPath) ->
  abs = path.resolve dbPath
  return [] unless fs.existsSync abs

  # Project root: <path>/.sheets/activities/*.yaml (rows.source relative to path)
  nested = path.join abs, '.sheets', 'activities'
  if fs.existsSync nested
    return loadActivityDir nested, abs, path.join(abs, 'db')

  # Entity db named "db" whose parent is a sheets project
  parent = path.dirname abs
  parentActs = path.join parent, '.sheets', 'activities'
  if path.basename(abs) is 'db' and fs.existsSync parentActs
    return loadActivityDir parentActs, parent, abs

  # Bare entity directory (or empty dir we will use as a db) → one synthetic tab.
  unless fs.statSync(abs).isDirectory()
    return []
  base = path.basename abs.replace /\/+$/, ''
  base = path.basename(path.dirname abs) if base in ['db', '.']
  slug = slugify base
  [{
    slug
    title: base or slug
    source: abs
    columns: []
    componentLocks: {}
    revision: 0
    file: null
    root: abs
    ephemeral: true
  }]

export class Activities
  constructor: (@ws) ->
    @_slugCount = new Map()

  _file: (slug) -> path.join @ws.activitiesDir, "#{slug}.yaml"

  # Unique slug among already-emitted tabs (disk + scanned).
  _uniqueSlug: (want, taken) ->
    base = slugify want
    slug = base
    n = 2
    while taken.has slug
      slug = "#{base}-#{n}"
      n++
    taken.add slug
    slug

  # Workspace .sheets/activities (cwd) — primary, mutable.
  _listDisk: ->
    loadActivityDir @ws.activitiesDir, @ws.root, @ws.db

  # Activities discovered from each --db path (and not already covered by disk).
  _listScanned: (disk) ->
    dbs = @ws.dbs ? [@ws.db]
    takenSlugs = new Set(a.slug for a in disk)
    takenSources = new Set(path.resolve a.source for a in disk)
    out = []
    for dbPath in dbs
      for a in scanDbPath dbPath
        src = path.resolve a.source
        # Skip if workspace already has a tab on this entity source.
        continue if takenSources.has src
        # Skip synthetic if we already have any tab (disk) — only when single default db?
        # Always skip duplicate sources; always include new sources.
        slug = if takenSlugs.has a.slug
          @_uniqueSlug a.slug, takenSlugs
        else
          takenSlugs.add a.slug
          a.slug
        takenSources.add src
        out.push { a..., slug }
    out

  list: ->
    disk = @_listDisk()
    scanned = @_listScanned disk
    # If workspace has no activities yet but we have --db paths, scanned tabs alone are fine.
    # If workspace has activities AND scanned finds the same sources, scanned is empty for those.
    # When workspace is empty and only default db exists with no entity yamls, still show synthetic.
    if disk.length is 0 and scanned.length is 0
      # Fall back: one tab for primary db
      for a in scanDbPath @ws.db
        return [{ a..., slug: @_uniqueSlug(a.slug, new Set()) }]
    disk.concat scanned

  get: (slug) ->
    (a for a in @list() when a.slug is slug)[0] ? null

  save: (slug, doc) ->
    fs.mkdirSync @ws.activitiesDir, recursive: true
    fs.writeFileSync @_file(slug), yaml.dump(doc)

  # Excel-style +: instant, auto-named, no dialog (§6 Δ)
  create: ->
    n = 1
    n++ while fs.existsSync @_file "sheet#{n}"
    slug = "sheet#{n}"
    # Prefer absolute source when primary db is outside the workspace root.
    rel = path.relative(@ws.root, @ws.db)
    source = if rel and not rel.startsWith('..') and not path.isAbsolute rel
      rel or 'db'
    else
      @ws.db
    @save slug, { title: "Sheet#{n}", rows: { source: source }, columns: [], revision: 0 }
    slug

  remove: (slug) ->
    # Ephemeral (scanned-only) tabs have no workspace file — nothing to delete on disk.
    file = @_file slug
    return false unless fs.existsSync file
    fs.rmSync file, force: true
    true

  update: (slug, mut) ->
    file = @_file slug
    # If this is a scanned/ephemeral activity, materialize it into the workspace first.
    unless fs.existsSync file
      a = @get slug
      return null unless a?
      doc0 = {
        title: a.title
        rows: { source: a.source }
        columns: a.columns ? []
        component_locks: a.componentLocks ? {}
        revision: a.revision ? 0
      }
      @save slug, doc0
    doc = yaml.load(fs.readFileSync(file, 'utf8')) ? {}
    mut doc
    fs.writeFileSync file, yaml.dump(doc)
    doc
