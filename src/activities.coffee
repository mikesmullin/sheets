# Activities = worksheet tabs: named, ordered column lists, each with its own rows.source —
# one sheets process manages many databases (§3). Columns: {field: 'comp.field'} (default
# stage, not playable) or {stage: '<slug>'} (scripted stage in .sheets/stages/).
# Optional per-column `width` (px) is UI layout only and round-trips through activity YAML.
# Optional `hidden: true` keeps the column in order while omitting it from the grid —
# so show/hide (all|none, checkboxes) does not scramble ordering.
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export class Activities
  constructor: (@ws) ->

  _file: (slug) -> path.join @ws.activitiesDir, "#{slug}.yaml"

  list: ->
    dir = @ws.activitiesDir
    return [] unless fs.existsSync dir
    out = []
    for f in fs.readdirSync(dir).sort() when /\.ya?ml$/.test f
      slug = f.replace /\.ya?ml$/, ''
      try
        doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) ? {}
      catch
        continue
      out.push {
        slug
        title: doc.title ? slug
        source: path.resolve @ws.root, (doc.rows?.source ? @ws.db)
        columns: doc.columns ? []
        componentLocks: doc.component_locks ? {}
        revision: Number(doc.revision ? 0)
      }
    out

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
    rel = path.relative(@ws.root, @ws.db) or 'db'
    @save slug, { title: "Sheet#{n}", rows: { source: rel }, columns: [], revision: 0 }
    slug

  remove: (slug) -> fs.rmSync @_file(slug), force: true

  update: (slug, mut) ->
    file = @_file slug
    doc = yaml.load(fs.readFileSync(file, 'utf8')) ? {}
    mut doc
    fs.writeFileSync file, yaml.dump(doc)
    doc
