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

# Nested set under an object for multi-segment paths (e.g. destination.permanent_space).
export setAtPath = (root, dotPath, value) ->
  parts = String(dotPath ? '').split('.').filter Boolean
  return root unless parts.length and root? and typeof root is 'object' and not Array.isArray root
  cur = root
  for part, idx in parts
    if idx is parts.length - 1
      cur[part] = value
    else
      next = cur[part]
      unless next? and typeof next is 'object' and not Array.isArray next
        next = {}
        cur[part] = next
      cur = next
  root

# Nested delete; returns true when a key was removed. Prunes empty plain objects upward.
export deleteAtPath = (root, dotPath) ->
  parts = String(dotPath ? '').split('.').filter Boolean
  return false unless parts.length and root? and typeof root is 'object' and not Array.isArray root
  stack = []
  cur = root
  for part, idx in parts
    return false unless cur? and typeof cur is 'object' and not Array.isArray cur
    if idx is parts.length - 1
      return false unless Object.prototype.hasOwnProperty.call cur, part
      delete cur[part]
      # Prune empty parents created only as containers (not the doc root).
      for i in [stack.length - 1..0] by -1
        { parent, key } = stack[i]
        child = parent[key]
        break unless child? and typeof child is 'object' and not Array.isArray(child) and Object.keys(child).length is 0
        delete parent[key]
      return true
    stack.push { parent: cur, key: part }
    cur = cur[part]
  false

# Shallow two-level merge (§4): component -> field. Field values REPLACE wholesale
# (objects/arrays too); null is a value, never a deletion — fields accrue.
# Field keys may contain dots (component-relative nested path) and are applied via setAtPath.
export mergePatch = (doc, patch) ->
  return doc unless patch? and typeof patch is 'object' and not Array.isArray patch
  for comp, fields of patch
    if fields? and typeof fields is 'object' and not Array.isArray fields
      doc[comp] ?= {}
      doc[comp] = {} unless typeof doc[comp] is 'object' and not Array.isArray doc[comp]
      for k, v of fields
        if String(k).includes '.'
          setAtPath doc[comp], k, v
        else
          doc[comp][k] = v
    else
      doc[comp] = fields
  doc

export deepFreeze = (o) ->
  return o unless o? and typeof o is 'object'
  Object.freeze o
  deepFreeze v for own k, v of o
  o

# read a dot-path (component.field[.nested...]) off a doc
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

# Locate schema.yaml / schema.yml under a db dir (entity source).
export schemaFileFor = (dbDir) ->
  for f in ['schema.yaml', 'schema.yml']
    p = path.join dbDir, f
    return p if fs.existsSync p
  path.join dbDir, 'schema.yaml'

export readSchemaDoc = (dbDir) ->
  file = schemaFileFor dbDir
  return { file, doc: {}, exists: false } unless fs.existsSync file
  try
    doc = yaml.load(fs.readFileSync(file, 'utf8')) ? {}
  catch
    doc = {}
  doc = {} unless doc? and typeof doc is 'object' and not Array.isArray doc
  { file, doc, exists: true }

export writeSchemaDoc = (dbDir, doc) ->
  file = schemaFileFor dbDir
  fs.mkdirSync path.dirname(file), recursive: true
  tmp = "#{file}.tmp~"
  fs.writeFileSync tmp, yaml.dump(doc ? {})
  fs.renameSync tmp, file
  file

# Schema field groups for the column picker. A schema may declare either
# `components: { component: { fields: { field: ... } } }` or a direct field map.
export componentFieldsFor = (dbDir) ->
  { doc, exists } = readSchemaDoc dbDir
  return [] unless exists
  components = doc.schema?.components ? doc.components ? null
  return [] unless components? and typeof components is 'object'
  out = []
  for component, definition of components
    source = definition?.fields ? definition
    names = if Array.isArray(source) then source else Object.keys(source ? {})
    fields = (String(name) for name in names when String(name).trim())
    out.push { component: String(component), fields } if fields.length
  out

# True if component.field is declared in schema.yaml.
export schemaHasField = (dbDir, component, field) ->
  { doc, exists } = readSchemaDoc dbDir
  return false unless exists
  components = doc.schema?.components ? doc.components ? null
  return false unless components?[component]?
  definition = components[component]
  source = definition?.fields ? definition
  return source.includes(field) if Array.isArray source
  return Object.prototype.hasOwnProperty.call(source ? {}, field)

# Guess a simple scalar type from non-null sample values.
export guessFieldType = (values) ->
  samples = (v for v in values when v? and v isnt '')
  return 'string' unless samples.length
  if samples.every((v) -> typeof v is 'boolean' or v is true or v is false or v is 'true' or v is 'false')
    return 'boolean'
  if samples.every((v) -> typeof v is 'number' or (typeof v is 'string' and v.trim() isnt '' and Number.isFinite(Number(v))))
    return 'number'
  if samples.every((v) -> Array.isArray v)
    return 'array'
  if samples.every((v) -> v? and typeof v is 'object' and not Array.isArray(v))
    return 'object'
  'string'

# Normalize a component definition to `{ fields: { name: { type } } }`.
normalizeComponentDef = (def) ->
  if Array.isArray def
    map = {}
    map[String(n)] = { type: 'string' } for n in def when String(n).trim()
    return { fields: map }
  def = {} unless def? and typeof def is 'object' and not Array.isArray def
  if def.fields?
    if Array.isArray def.fields
      map = {}
      map[String(n)] = { type: 'string' } for n in def.fields when String(n).trim()
      def.fields = map
    else if typeof def.fields is 'object'
      for k, v of def.fields
        def.fields[k] = if v? and typeof v is 'object' and not Array.isArray(v) then v else { type: String(v ? 'string') }
    else
      def.fields = {}
  else
    # Flat map: { name: { type } } or { name: 'string' }
    map = {}
    for k, v of def
      map[k] = if v? and typeof v is 'object' and not Array.isArray(v) then v else { type: String(v ? 'string') }
    def = { fields: map }
  def.fields ?= {}
  def

# Add or remove a field declaration under components.<component>.fields.
# `type` is used when adding; ignored when removing.
export mutateSchemaField = (dbDir, component, field, action, type = 'string') ->
  { file, doc } = readSchemaDoc dbDir
  # Prefer existing components location (top-level or schema.components).
  holder = if doc.components? then doc else if doc.schema?.components? then doc.schema else doc
  holder.components ?= {}
  def = normalizeComponentDef holder.components[component]
  holder.components[component] = def
  if action is 'add'
    def.fields[field] = { type: type or 'string' }
  else if action is 'remove'
    delete def.fields[field]
    delete holder.components[component] if Object.keys(def.fields).length is 0
  else
    throw new Error "unknown schema action: #{action}"
  written = writeSchemaDoc dbDir, doc
  { file: written, component, field, action, type: def.fields[field]?.type ? null }

# Delete component.field from every entity YAML under dbDir. Returns count of files changed.
export deleteFieldFromAll = (dbDir, component, field) ->
  changed = 0
  for file in walkDb dbDir
    { doc, body } = readEntityFile file
    continue unless doc?[component]? and typeof doc[component] is 'object' and not Array.isArray(doc[component])
    continue unless Object.prototype.hasOwnProperty.call doc[component], field
    delete doc[component][field]
    # Drop empty component object
    keys = Object.keys doc[component]
    delete doc[component] if keys.length is 0
    writeEntityFile file, doc, body
    changed++
  changed

export labelFor = (id, doc, displayFields) ->
  cls = id.split('/')[0]
  if displayFields?[cls]
    v = getPath doc, displayFields[cls]
    return String(v) if v?
  id.split('/').pop()
