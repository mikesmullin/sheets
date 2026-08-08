# The benchmark stage (§4, M6): provides canonical fruit colors without requiring a model
# provider, so the bundled example is runnable immediately after `sheets serve`.
export meta =
  title: 'Fruit color'
  prompt: 'Assign the fruit its canonical display color.'
  writes: ['appearance.color']

# Gate: upstream deps only. (Do not check "already written" — false parks jobs as idle forever.)
export gate = (entity) ->
  name = entity.produce?.name
  name? and String(name).trim() isnt ''

colors =
  apple: '#c0392b'
  apricot: '#fb9c5a'
  banana: '#f5d547'
  blackberry: '#2d1839'
  blueberry: '#355c9a'
  cantaloupe: '#f4a261'
  cherry: '#c1121f'
  clementine: '#f77f00'
  coconut: '#795548'
  cranberry: '#9b1d20'
  currant: '#4a001f'
  date: '#7b3f00'
  dragonfruit: '#ec407a'
  durian: '#8b9a36'
  elderberry: '#311b4b'
  fig: '#6b2d5c'
  gooseberry: '#91a342'
  grape: '#6d3f8f'
  grapefruit: '#f68b6b'
  guava: '#7cb342'
  honeydew: '#c5e1a5'
  jackfruit: '#d4a017'
  jujube: '#8d3b2d'
  kiwi: '#7cb342'
  kumquat: '#f57c00'
  lemon: '#f7e733'
  lime: '#8bc34a'
  lychee: '#e57373'
  mango: '#ff9800'
  mulberry: '#4a235a'
  nectarine: '#ff8f5a'
  olive: '#708238'
  orange: '#f57c00'
  papaya: '#ff7043'
  passionfruit: '#5e2a84'
  peach: '#f6a57a'
  pear: '#cddc39'
  persimmon: '#e65100'
  pineapple: '#f4c430'
  plantain: '#d4a017'
  plum: '#6a1b5d'
  pomegranate: '#b71c1c'
  quince: '#e1b12c'
  rambutan: '#d6336c'
  raspberry: '#c2185b'
  starfruit: '#d4e157'
  strawberry: '#e53935'
  tamarind: '#795548'
  tangerine: '#ff8f00'
  watermelon: '#2e7d32'

fallbackColor = (name) ->
  hash = 0
  hash = (hash * 31 + name.charCodeAt(i)) | 0 for i in [0...name.length]
  '#' + ('00000' + (Math.abs(hash) % 0xffffff).toString(16)).slice(-6)

# Delete: reset to black — view keeps swatch chrome even when cleared.
export clear = (entity) ->
  appearance: color: '#000000'

export reduce = (entity, ctx) ->
  # Idempotent: already filled → no-op, but '#000000' is the Delete sentinel — treat as empty so re-Play regenerates
  c = String(entity.appearance?.color ? '').trim().toLowerCase()
  if c isnt '' and c isnt '#000000'
    ctx.log "skip #{entity.produce.name}: appearance.color already set"
    return {}
  name = String(entity.produce.name).toLowerCase()
  color = colors[name] ? fallbackColor(name)
  ctx.log "#{name} → #{color}"
  appearance: color: color

# Cell views are self-contained static HTML (escape interpolated values!) — the sheet
# renders them via x-html; no directive bindings inside cells.
esc = (s) -> String(s ? '').replace /[&<>"']/g, (c) -> '&#' + c.charCodeAt(0) + ';'

export views =
  cell: (entity) ->
    color = entity.appearance?.color ? ''
    return { template: '<span style="color:#666">—</span>' } unless color
    template: """
      <div class="cell-swatch">
        <span class="swatch" style="background:#{esc color}"></span>
        <span>#{esc color}</span>
      </div>
      """

export sort = (a, b) ->
  x = a.appearance?.color ? ''
  y = b.appearance?.color ? ''
  if x < y then -1 else if x > y then 1 else 0
