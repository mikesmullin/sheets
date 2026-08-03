# Entity file I/O. One file = one entity; two-level component->field YAML.
# Interop: flat agent-pipeline dbs (db/<id>.yaml) and brain dbs (db/<Class>/<id>.md,
# frontmatter + markdown body preserved untouched on write) both load as-is (§3).
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export EXTS = ['.yaml', '.yml', '.md']

parseMd = (text) ->
  m = text.match /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
  return { doc: {}, body: text } unless m
  { doc: (yaml.load(m[1]) ? {}), body: m[2] }

export readEntityFile = (file) ->
  text = fs.readFileSync file, 'utf8'
  if file.endsWith '.md'
    { doc, body } = parseMd text
  else
    doc = yaml.load(text) ? {}
    body = null
  doc = {} unless doc? and typeof doc is 'object' and not Array.isArray doc
  { doc, body }

export writeEntityFile = (file, doc, body = null) ->
  text = if file.endsWith '.md'
    "---\n#{yaml.dump doc}---\n#{body ? ''}"
  else
    yaml.dump doc
  tmp = "#{file}.tmp~"
  fs.mkdirSync path.dirname(file), recursive: true
  fs.writeFileSync tmp, text
  fs.renameSync tmp, file

export walkDb = (dir) ->
  out = []
  walk = (d) ->
    for name in fs.readdirSync(d).sort()
      continue if name.startsWith('.') or name.endsWith('.tmp~') or name in ['schema.yaml', 'schema.yml']
      full = path.join d, name
      st = fs.statSync full
      if st.isDirectory() then walk full
      else out.push full if path.extname(name) in EXTS
    null
  walk dir if fs.existsSync dir
  out

# id = relative path sans extension (path separators normalized to /)
export idFor = (dbDir, file) ->
  rel = path.relative dbDir, file
  rel.slice(0, rel.length - path.extname(rel).length).replaceAll path.sep, '/'

export fileFor = (dbDir, id) ->
  for ext in EXTS
    f = path.join dbDir, id + ext
    return f if fs.existsSync f
  null

# Shallow two-level merge (§4): component -> field. Field values REPLACE wholesale
# (objects/arrays too); null is a value, never a deletion — fields accrue.
export mergePatch = (doc, patch) ->
  return doc unless patch? and typeof patch is 'object' and not Array.isArray patch
  for comp, fields of patch
    if fields? and typeof fields is 'object' and not Array.isArray fields
      doc[comp] ?= {}
      doc[comp] = {} unless typeof doc[comp] is 'object' and not Array.isArray doc[comp]
      for k, v of fields
        doc[comp][k] = v
    else
      doc[comp] = fields
  doc

export deepFreeze = (o) ->
  return o unless o? and typeof o is 'object'
  Object.freeze o
  deepFreeze v for own k, v of o
  o

# read a dot-path (component.field) off a doc
export getPath = (doc, dotPath) ->
  cur = doc
  for part in String(dotPath).split '.'
    return undefined unless cur? and typeof cur is 'object'
    cur = cur[part]
  cur

# schema.yaml (brain convention) display-field hints: Class -> field path (§3, §6 Λ)
export displayFieldsFor = (dbDir) ->
  out = {}
  for f in ['schema.yaml', 'schema.yml']
    p = path.join dbDir, f
    continue unless fs.existsSync p
    try
      doc = yaml.load(fs.readFileSync(p, 'utf8')) ? {}
      classes = doc.schema?.classes ? doc.classes ? {}
      for cls, def of classes
        out[cls] = def.display if def?.display
    catch
      null
  out

# Schema field groups for the column picker. A schema may declare either
# `components: { component: { fields: { field: ... } } }` or a direct field map.
export componentFieldsFor = (dbDir) ->
  for f in ['schema.yaml', 'schema.yml']
    p = path.join dbDir, f
    continue unless fs.existsSync p
    try
      doc = yaml.load(fs.readFileSync(p, 'utf8')) ? {}
      components = doc.schema?.components ? doc.components ? null
      continue unless components? and typeof components is 'object'
      out = []
      for component, definition of components
        source = definition?.fields ? definition
        names = if Array.isArray(source) then source else Object.keys(source ? {})
        fields = (String(name) for name in names when String(name).trim())
        out.push { component: String(component), fields } if fields.length
      return out
    catch
      null
  []

export labelFor = (id, doc, displayFields) ->
  cls = id.split('/')[0]
  if displayFields?[cls]
    v = getPath doc, displayFields[cls]
    return String(v) if v?
  id.split('/').pop()
