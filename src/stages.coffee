# Stage modules (§4): one .coffee file, exports meta / reduce / gate / views / sort.
# Compiled once per mtime; served to the browser as ESM (views only are used there).
# Convention: stage files have NO imports — everything arrives via ctx.
import fs from 'node:fs'
import path from 'node:path'
import CoffeeScript from 'coffeescript'

export class Stages
  constructor: (@ws) ->
    @cache = new Map()   # slug -> { mod, js, mtime }

  file: (slug) -> path.join @ws.stagesDir, "#{slug}.coffee"

  exists: (slug) -> fs.existsSync @file slug

  list: ->
    return [] unless fs.existsSync @ws.stagesDir
    (f.replace /\.coffee$/, '' for f in fs.readdirSync(@ws.stagesDir).sort() when f.endsWith '.coffee')

  source: (slug) ->
    f = @file slug
    return null unless fs.existsSync f
    fs.readFileSync f, 'utf8'

  write: (slug, src) ->
    fs.mkdirSync @ws.stagesDir, recursive: true
    f = @file slug
    fs.writeFileSync "#{f}.tmp~", src
    fs.renameSync "#{f}.tmp~", f
    @invalidate slug

  invalidate: (slug) -> @cache.delete slug

  compile: (slug) ->
    src = @source slug
    return null unless src?
    CoffeeScript.compile src, bare: true, header: false

  _fresh: (slug) ->
    f = @file slug
    return null unless fs.existsSync f
    mtime = fs.statSync(f).mtimeMs
    hit = @cache.get slug
    return hit if hit and hit.mtime is mtime
    js = @compile slug
    entry = { js, mtime, mod: null }
    @cache.set slug, entry
    entry

  # browser module (views + meta); same compiled JS
  js: (slug) -> @_fresh(slug)?.js ? null

  load: (slug) ->
    entry = @_fresh slug
    return null unless entry
    unless entry.mod
      url = 'data:text/javascript;base64,' + Buffer.from(entry.js).toString('base64')
      entry.mod = await `import(url)`
    entry.mod

  meta: (slug) ->
    mod = await @load slug
    mod?.meta ? null
