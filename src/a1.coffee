# Ephemeral A1 coordinates (§6 Κ): resolved at enqueue/chat time, never stored.
# Grammar: B3:D4, B:B (whole column), 4:4 (whole row), B4,D5,D6 (disjoint), composable by comma.
export colToIndex = (letters) ->
  n = 0
  n = n * 26 + (c.charCodeAt(0) - 64) for c in letters.toUpperCase()
  n - 1

export indexToCol = (i) ->
  s = ''
  i = i + 1
  while i > 0
    m = (i - 1) % 26
    s = String.fromCharCode(65 + m) + s
    i = (i - m - 1) // 26
  s

parseCell = (tok) ->
  m = tok.match /^([A-Za-z]+)?(\d+)?$/
  return null unless m and (m[1] or m[2])
  { col: (if m[1]? then colToIndex m[1] else null), row: (if m[2]? then Number(m[2]) - 1 else null) }

# -> list of {cols: [i..] | null (=all), rows: [i..] | null (=all)}
export parseRange = (expr) ->
  out = []
  for part in String(expr).split ',' when part.trim()
    part = part.trim()
    [a, b] = part.split ':'
    ca = parseCell a
    continue unless ca
    cb = if b? then parseCell(b) else ca
    continue unless cb
    cols = if ca.col? and cb.col?
      [Math.min(ca.col, cb.col)..Math.max(ca.col, cb.col)]
    else null
    rows = if ca.row? and cb.row?
      [Math.min(ca.row, cb.row)..Math.max(ca.row, cb.row)]
    else null
    out.push { cols, rows }
  out

# resolve ranges against an activity's ordered columns + row-ordered entity ids
# -> [{ id, stage }] for playable (stage) cells; skipped = field-only columns touched
export resolveCells = (ranges, columns, ids) ->
  cells = []
  skipped = new Set()
  seen = new Set()
  for r in ranges
    cols = r.cols ? [0...columns.length]
    rows = r.rows ? [0...ids.length]
    for ci in cols when ci < columns.length
      col = columns[ci]
      unless col.stage?
        skipped.add ci
        continue
      for ri in rows when ri < ids.length
        k = "#{ids[ri]} #{col.stage}"
        continue if seen.has k
        seen.add k
        cells.push { id: ids[ri], stage: col.stage }
  { cells, skipped: Array.from(skipped) }
