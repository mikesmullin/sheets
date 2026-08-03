# Stage modules (§4): one .coffee file, exports meta / reduce / gate / views / sort.
# Compiled once per mtime; served to the browser as ESM (views only are used there).
# Convention: stage files have NO imports — everything arrives via ctx.
import fs from 'node:fs'
import path from 'node:path'
import CoffeeScript from 'coffeescript'

export class Stages
  constructor: (@ws) ->
    @cache = new Map()   # slug -> { mod, js, mtime, error }

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

  remove: (slug) ->
    f = @file slug
    return false unless fs.existsSync f
    fs.rmSync f, force: true
    @invalidate slug
    true

  invalidate: (slug) -> @cache.delete slug

  # Compile never throws — bad Angela-authored Coffee must not crash the server.
  # Returns { js, error } where error is a string message when compile fails.
  compile: (slug) ->
    src = @source slug
    return { js: null, error: 'stage file missing' } unless src?
    try
      js: CoffeeScript.compile(src, bare: true, header: false), error: null
    catch err
      msg = String(err?.message ? err)
      # CoffeeScript syntax errors often embed the whole source — keep a short message.
      msg = msg.split('\n')[0] if msg.length > 240
      { js: null, error: msg }

  _fresh: (slug) ->
    f = @file slug
    return null unless fs.existsSync f
    mtime = fs.statSync(f).mtimeMs
    hit = @cache.get slug
    return hit if hit and hit.mtime is mtime
    { js, error } = @compile slug
    entry = { js, mtime, mod: null, error }
    @cache.set slug, entry
    entry

  # browser module (views + meta); same compiled JS
  js: (slug) ->
    entry = @_fresh slug
    return null unless entry?
    return null if entry.error?
    entry.js ? null

  loadError: (slug) -> @_fresh(slug)?.error ? null

  load: (slug) ->
    entry = @_fresh slug
    return null unless entry
    if entry.error?
      err = new Error "stage '#{slug}' compile failed: #{entry.error}"
      err.code = 'STAGE_COMPILE'
      throw err
    unless entry.mod
      try
        url = 'data:text/javascript;base64,' + Buffer.from(entry.js).toString('base64')
        entry.mod = await `import(url)`
      catch err
        entry.error = String(err?.message ? err)
        entry.mod = null
        e = new Error "stage '#{slug}' import failed: #{entry.error}"
        e.code = 'STAGE_IMPORT'
        throw e
    entry.mod

  meta: (slug) ->
    try
      mod = await @load slug
      mod?.meta ? null
    catch err
      { error: String(err?.message ? err) }
