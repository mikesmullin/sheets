// sheets SPA (§6). Local m-js distribution symlinked from /workspace/m-js/dist/m.js.
// Layout per Wireframe A: toolbars (Α), column letters (Κ), row rail (Λ), magic row (Β),
// cells (Γ), selection (Ι), activity tabs (Δ), queue (Ζ), slider (Η), run log (Μ),
// Angela chat (Ε/Θ). Stage focus mode (§9) at #/stage/<slug>.
import M from './m.js'

const ROWH = 28
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const colLetter = (i) => { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26 } return s }
const hashColor = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return `hsl(${Math.abs(h) % 360},55%,62%)` }
const getPath = (doc, p) => { let c = doc; for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return undefined; c = c[k] } return c }
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stage'
const copyColumns = (columns) => columns.map((column) => ({ ...column }))

M.mount('#app', () => ({
  // ---- state ----
  meta: null, actSlug: null, total: 0, rows: [], winStart: 0, fields: [], fieldTree: [], stageTree: [], componentLocks: {},
  sel: { ranges: [], active: null, anchor: null },
  cellStates: {}, stagePending: {}, viewMods: {}, viewLoading: {},
  wsConnected: false,
  desynced: false,
  q: { queued: 0, idle: 0, running: 0, done: 0, error: 0, concurrency: 0 },
  logs: [], conc: 0, dragging: null,
  persistTimers: {},
  logPinned: true, _lastLogTop: 0,
  chat: { enabled: false, messages: [], input: '', busy: false },
  editing: null, // {r, ci, value, x, y, w}
  renaming: null, // {id, value}
  magicInput: {}, fieldColumnEdit: null, // ci -> draft prompt / {ci, value}
  sort: null, // {ci, dir}
  search: '',
  focus: null, // {slug, source, meta, results, busy}
  toast: '', tabMenu: null, tabRename: null,
  fieldMenu: false,

  // ---- derived ----
  get act() { return this.meta?.activities?.find((a) => a.slug === this.actSlug) ?? this.meta?.activities?.[0] ?? null },
  get columns() { return this.act?.columns ?? [] },

  async init() {
    await this.loadMeta()
    this.connectWS()
    const el = document.querySelector('.gridwrap')
    window.addEventListener('keydown', (e) => this.globalKey(e))
    window.addEventListener('hashchange', () => this.route())
    this.route()
  },

  route() {
    const m = location.hash.match(/^#\/stage\/([\w-]+)/)
    if (m) this.openFocus(m[1])
    else this.focus = null
    const a = location.hash.match(/^#\/a\/([\w-]+)/)
    if (a) {
      const exists = this.meta?.activities?.some((activity) => activity.slug === a[1])
      if (!exists) {
        history.replaceState(null, '', `${location.pathname}${location.search}`)
        this.actSlug = this.meta?.activities?.[0]?.slug ?? null
        this.refreshWindow(true)
      } else if (a[1] !== this.actSlug) {
        this.actSlug = a[1]
        this.refreshWindow(true)
      }
    }
  },

  async loadMeta(resetWindow = true) {
    this.meta = await (await fetch('/api/meta')).json()
    this.chat.enabled = this.meta.chat
    if (!this.actSlug) this.actSlug = this.meta.activities[0]?.slug ?? null
    await this.refreshWindow(resetWindow)
    const [fieldData, stageData] = await Promise.all([
      fetch(`/api/fields?activity=${this.actSlug}`).then((response) => response.json()),
      fetch('/api/stages').then((response) => response.json()),
    ])
    this.fields = fieldData.fields
    this.fieldTree = fieldData.components.map((group) => ({
      component: group.component,
      fields: group.fields.map((name) => ({ name, path: `${group.component}.${name}` })),
    }))
    this.stageTree = stageData.stages
    this.componentLocks = this.act?.componentLocks ?? {}
  },
  canPersist() { return !this.desynced },
  markDesync() {
    this.desynced = true
    M.redraw()
  },
  async refreshPersistent() {
    await this.loadMeta(false)
    this.redrawGrid()
    this.desynced = false
    M.redraw()
  },
  async persistActivity(data) {
    if (!this.canPersist()) return null
    const response = await fetch(`/api/activity/${this.actSlug}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...data, revision: this.act?.revision ?? 0 }),
    })
    const result = await response.json()
    if (response.status === 409) {
      this.markDesync()
      return null
    }
    if (!response.ok || !result.ok) throw new Error(result.error ?? `could not save activity (${response.status})`)
    return result
  },

  // ---- window / virtualization (Γ) ----
  entityParams(offset, limit) {
    const params = new URLSearchParams({ activity: this.actSlug ?? '', offset, limit })
    if (this.search) params.set('q', this.search)
    if (this.sort) {
      const col = this.columns[this.sort.ci]
      if (col?.stage) params.set('sortStage', col.stage)
      else if (col?.field) params.set('sortField', col.field)
      params.set('dir', this.sort.dir)
    }
    return params
  },
  async refreshWindow(reset) {
    const el = document.querySelector('.gridwrap')
    const scrollTop = reset ? 0 : (el?.scrollTop ?? 0)
    const request = (this._windowRequest ?? 0) + 1
    this._windowRequest = request
    const visible = Math.ceil((el?.clientHeight ?? 600) / ROWH) + 20
    const start = Math.max(0, Math.floor(scrollTop / ROWH) - 10)
    const params = this.entityParams(start, visible)
    const data = await (await fetch(`/api/entities?${params}`)).json()
    if (request !== this._windowRequest) return
    this.total = data.total
    this.rows = data.rows
    this.winStart = data.offset
    if (!reset) requestAnimationFrame(() => {
      const grid = document.querySelector('.gridwrap')
      if (grid) grid.scrollTop = scrollTop
    })
  },
  onScroll() {
    clearTimeout(this._scrollT)
    this._scrollT = setTimeout(() => this.refreshWindow(false), 60)
  },
  get topPad() { return this.winStart * ROWH },
  get bottomPad() { return Math.max(0, (this.total - this.winStart - this.rows.length) * ROWH) },

  // ---- cell rendering (Γ, §4.1 default widgets) ----
  ensureView(slug) {
    if (this.viewMods[slug] !== undefined || this.viewLoading[slug]) return
    this.viewLoading[slug] = true
    import(`/api/stage/${slug}/views.js?t=${Date.now()}`)
      .then((m) => { this.viewMods[slug] = m })
      .catch(() => { this.viewMods[slug] = null })
      .finally(() => { this.viewLoading[slug] = false })
  },
  cellHtml(row, ci) {
    const col = this.columns[ci]
    if (!col) return ''
    if (col.stage) {
      this.ensureView(col.stage)
      const mod = this.viewMods[col.stage]
      if (mod?.views?.cell) {
        try { return mod.views.cell(row.doc)?.template ?? '' } catch (e) { return `<span class="cellstate">⚠ ${esc(e.message)}</span>` }
      }
      const writes = mod?.meta?.writes?.[0]
      return writes ? this.widget(getPath(row.doc, writes)) : ''
    }
    if (col.field) return this.widget(getPath(row.doc, col.field))
    return ''
  },
  widget(v) {
    if (v === undefined) return '<span style="color:var(--dim)">—</span>'
    if (v === null) return '<span style="color:var(--dim)">—</span>'
    if (typeof v === 'boolean') return `<input type="checkbox" disabled ${v ? 'checked' : ''}>`
    if (typeof v === 'number') return `<span style="float:right;font-family:ui-monospace,monospace">${esc(v)}</span>`
    if (Array.isArray(v)) return `<span style="color:var(--dim)">[…] ${v.length} items</span>`
    if (typeof v === 'object') return `<span style="color:var(--dim)">{…} ${Object.keys(v).length} keys</span>`
    const s = String(v)
    if (/^#[0-9a-f]{6}$/i.test(s)) return `<span class="cell-swatch"><span class="swatch" style="background:${esc(s)}"></span>${esc(s)}</span>`
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) return `<span title="${esc(s)}">${esc(new Date(s).toLocaleDateString())}</span>`
    if (/^https?:\/\//.test(s)) return `<a href="${esc(s)}" target="_blank">${esc(s)}</a>`
    if (s.includes('\n')) return `${esc(s.split('\n')[0])} <span style="color:var(--dim)">¶${s.split('\n').length}</span>`
    return esc(s)
  },
  cellStateClass(row, ci) {
    const col = this.columns[ci]
    if (!col?.stage) return ''
    const st = this.cellStates[`${row.id}|${col.stage}`]
    return st ? `st-${st.state}` : ''
  },

  // ---- selection (Ι) ----
  absRow(i) { return this.winStart + i },
  cellDown(i, ci, e) {
    if (this.editing) this.commitEdit()
    const r = this.absRow(i)
    if (e.shiftKey && this.sel.anchor) {
      const a = this.sel.anchor
      this.sel.ranges = [...(e.ctrlKey || e.metaKey ? this.sel.ranges : []).slice(0, -1),
        { r0: Math.min(a.r, r), c0: Math.min(a.c, ci), r1: Math.max(a.r, r), c1: Math.max(a.c, ci) }]
    } else if (e.ctrlKey || e.metaKey) {
      this.sel.ranges.push({ r0: r, c0: ci, r1: r, c1: ci })
      this.sel.anchor = { r, c: ci }
    } else {
      this.sel.ranges = [{ r0: r, c0: ci, r1: r, c1: ci }]
      this.sel.anchor = { r, c: ci }
    }
    this.sel.active = { r, c: ci }
    this._dragSel = true
  },
  cellOver(i, ci, e) {
    if (!this._dragSel || !(e.buttons & 1)) return
    const a = this.sel.anchor; if (!a) return
    const r = this.absRow(i)
    this.sel.ranges[this.sel.ranges.length - 1] = { r0: Math.min(a.r, r), c0: Math.min(a.c, ci), r1: Math.max(a.r, r), c1: Math.max(a.c, ci) }
    this.sel.active = { r, c: ci }
  },
  cellUp() { this._dragSel = false },
  colHeadClick(ci, e) {
    if (e.altKey) return this.toggleSort(ci)
    const range = { r0: 0, c0: ci, r1: Math.max(0, this.total - 1), c1: ci }
    if (e.ctrlKey || e.metaKey) this.sel.ranges.push(range)
    else this.sel.ranges = [range]
    this.sel.anchor = { r: 0, c: ci }
    this.sel.active = { r: 0, c: ci }
  },
  rowHeadClick(i, e) {
    const r = this.absRow(i)
    const range = { r0: r, c0: 0, r1: r, c1: Math.max(0, this.columns.length - 1) }
    if (e.ctrlKey || e.metaKey) this.sel.ranges.push(range)
    else this.sel.ranges = [range]
    this.sel.anchor = { r, c: 0 }
    this.sel.active = { r, c: 0 }
  },
  startRename(i) {
    const row = this.rows[i]
    if (!row) return
    const r = this.absRow(i)
    this.sel = { ranges: [{ r0: r, c0: 0, r1: r, c1: Math.max(0, this.columns.length - 1) }], active: { r, c: 0 }, anchor: { r, c: 0 } }
    this.renaming = { id: row.id, value: row.id }
    M.redraw()
    setTimeout(() => document.querySelector('.row-rename-input')?.focus(), 0)
  },
  renameKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); this.commitRename() }
    if (e.key === 'Escape') { this.renaming = null; M.redraw() }
  },
  async commitRename() {
    const rename = this.renaming
    if (!rename) return
    this.renaming = null
    M.redraw()
    if (!this.canPersist()) return
    const nextId = rename.value.trim()
    if (!nextId || nextId === rename.id) return
    try {
      const response = await fetch(`/api/entity/${encodeURIComponent(rename.id)}/rename?activity=${this.actSlug}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nextId }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error ?? `rename failed (${response.status})`)
      await this.refreshWindow(false)
      this.showToast(`renamed ${rename.id}.yaml`)
    } catch (error) {
      this.showToast(error.message ?? 'rename failed')
    }
  },
  inSel(i, ci) {
    const r = this.absRow(i)
    return this.sel.ranges.some((g) => r >= g.r0 && r <= g.r1 && ci >= g.c0 && ci <= g.c1)
  },
  rowSelected(i) {
    const r = this.absRow(i)
    return this.sel.ranges.some((g) => r >= g.r0 && r <= g.r1)
  },
  colSelected(ci) { return this.sel.ranges.some((g) => ci >= g.c0 && ci <= g.c1) },
  isActive(i, ci) { const a = this.sel.active; return a && a.r === this.absRow(i) && a.c === ci },
  globalKey(e) {
    if (this.editing || this.focus) return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    const a = this.sel.active
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      this.copySelection()
      return
    }
    if (e.key === 'Delete') {
      e.preventDefault()
      this.blankSelection()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault()
      this.sel.ranges = [{ r0: 0, c0: 0, r1: Math.max(0, this.total - 1), c1: Math.max(0, this.columns.length - 1) }]
      return
    }
    if (!a) return
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
    if (move) {
      e.preventDefault()
      let [dr, dc] = move
      if (e.ctrlKey || e.metaKey) { dr *= this.total; dc *= this.columns.length } // jump to edge
      const r = Math.max(0, Math.min(this.total - 1, a.r + dr))
      const c = Math.max(0, Math.min(this.columns.length - 1, a.c + dc))
      if (e.shiftKey && this.sel.anchor) {
        const an = this.sel.anchor
        this.sel.ranges[Math.max(0, this.sel.ranges.length - 1)] =
          { r0: Math.min(an.r, r), c0: Math.min(an.c, c), r1: Math.max(an.r, r), c1: Math.max(an.c, c) }
      } else {
        this.sel.ranges = [{ r0: r, c0: c, r1: r, c1: c }]
        this.sel.anchor = { r, c }
      }
      this.sel.active = { r, c }
      this.scrollToRow(r)
    }
    if (e.key === 'Enter') { e.preventDefault(); this.startEditActive() }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      e.preventDefault()
      this.startEditActive(e.key)
    }
  },
  scrollToRow(r) {
    const el = document.querySelector('.gridwrap')
    if (!el) return
    const y = r * ROWH
    if (y < el.scrollTop) el.scrollTop = y
    else if (y + ROWH > el.scrollTop + el.clientHeight - ROWH * 3) el.scrollTop = y - el.clientHeight + ROWH * 4
    this.onScroll()
  },
  get selReadout() {
    if (!this.sel.ranges.length) return ''
    const parts = this.sel.ranges.map((g) => {
      const whole = g.r0 === 0 && g.r1 >= this.total - 1
      const a = `${colLetter(g.c0)}${whole ? '' : g.r0 + 1}`
      const b = `${colLetter(g.c1)}${whole ? '' : g.r1 + 1}`
      return a === b ? a : `${a}:${b}`
    })
    const n = this.runnableCount()
    return `${parts.join(',')} — ${n} runnable cell${n === 1 ? '' : 's'}`
  },
  runnableCount() {
    let n = 0
    for (const g of this.sel.ranges)
      for (let c = g.c0; c <= g.c1; c++)
        if (this.columns[c]?.stage) n += (g.r1 - g.r0 + 1)
    return n
  },
  selA1() {
    return this.sel.ranges.map((g) => {
      const whole = g.r0 === 0 && g.r1 >= this.total - 1
      if (whole) return `${colLetter(g.c0)}:${colLetter(g.c1)}`
      return `${colLetter(g.c0)}${g.r0 + 1}:${colLetter(g.c1)}${g.r1 + 1}`
    }).join(',')
  },
  selectedCellCoords() {
    const cells = new Set()
    for (const range of this.sel.ranges) {
      for (let r = Math.max(0, range.r0); r <= Math.min(this.total - 1, range.r1); r++)
        for (let c = Math.max(0, range.c0); c <= Math.min(this.columns.length - 1, range.c1); c++) cells.add(`${r}:${c}`)
    }
    return [...cells].map((key) => key.split(':').map(Number)).sort(([ar, ac], [br, bc]) => ar - br || ac - bc)
  },
  clipboardValue(value) {
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  },
  async stageMeta(stage) {
    const mod = this.viewMods[stage]
    if (mod?.meta) return mod.meta
    this._stageMeta ??= {}
    if (!this._stageMeta[stage]) {
      this._stageMeta[stage] = fetch(`/api/stage/${encodeURIComponent(stage)}`).then((response) => response.json())
    }
    return (await this._stageMeta[stage]).meta ?? null
  },
  async stageWritePath(stage) {
    return (await this.stageMeta(stage))?.writes?.[0] ?? null
  },
  async copyCellValue(row, ci) {
    const col = this.columns[ci]
    if (!col) return ''
    if (col.field) return this.clipboardValue(getPath(row.doc, col.field))
    if (col.stage) return this.clipboardValue(getPath(row.doc, await this.stageWritePath(col.stage)))
    return ''
  },
  async copySelection() {
    const cells = this.selectedCellCoords()
    if (!cells.length) return this.showToast('no cells selected')
    try {
      const rows = await this.selectedRows()
      const values = []
      for (const [r, c] of cells) {
        const row = rows.get(r)
        if (row) values.push(await this.copyCellValue(row, c))
      }
      const text = values.join('\n')
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        document.body.appendChild(textarea)
        textarea.select()
        if (!document.execCommand('copy')) throw new Error('clipboard unavailable')
        textarea.remove()
      }
      this.showToast(`copied ${values.length} cell${values.length === 1 ? '' : 's'}`)
    } catch (error) {
      this.showToast(error.message ?? 'copy failed')
    }
  },

  // ---- editing (default-stage cells, §4.1) ----
  startEditActive(replaceWith = null) {
    const a = this.sel.active; if (!a) return
    const col = this.columns[a.c]
    if (!col?.field) return
    const i = a.r - this.winStart
    const row = this.rows[i]; if (!row) return
    const td = document.querySelector(`td[data-r="${i}"][data-c="${a.c}"]`)
    const rect = td?.getBoundingClientRect()
    const v = getPath(row.doc, col.field)
    const current = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))
    this.editing = { r: a.r, ci: a.c, id: row.id, field: col.field, value: replaceWith ?? current, x: rect?.left ?? 0, y: rect?.top ?? 0, w: rect?.width ?? 180 }
    setTimeout(() => document.querySelector('.overlay-edit input')?.focus(), 0)
  },
  editKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); this.commitEdit() }
    if (e.key === 'Escape') this.editing = null
  },
  async commitEdit() {
    const ed = this.editing; if (!ed) return
    this.editing = null
    if (!this.canPersist()) return
    const [component, ...rest] = ed.field.split('.')
    let value = ed.value
    if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value)
    else if (value === 'true' || value === 'false') value = value === 'true'
    try {
      const response = await fetch(`/api/entity/${encodeURIComponent(ed.id)}?activity=${this.actSlug}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ component, field: rest.join('.'), value }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error ?? `save failed (${response.status})`)
      this.rows = this.rows.map((row) => row.id === ed.id ? { ...row, doc: result.doc } : row)
      M.redraw()
      this.showToast(`saved ${ed.id}.yaml`)
    } catch (error) {
      this.showToast(error.message ?? 'save failed')
    }
  },
  cellDbl(i, ci) { this.sel.active = { r: this.absRow(i), c: ci }; this.startEditActive() },

  // ---- magic row (Β) ----
  magicTitle(ci) {
    const col = this.columns[ci]
    if (col?.stage) {
      this.ensureView(col.stage)
      return this.viewMods[col.stage]?.meta?.title ?? col.stage
    }
    if (col?.field) return col.field
    return null
  },
  colRunning(ci) {
    const col = this.columns[ci]; if (!col?.stage) return 0
    return this.stagePending[col.stage] ?? 0
  },
  syncStagePending() {
    const pending = {}
    for (const [key, state] of Object.entries(this.cellStates)) {
      if (!['queued', 'idle', 'running'].includes(state.state)) continue
      const stage = key.slice(key.lastIndexOf('|') + 1)
      pending[stage] = (pending[stage] ?? 0) + 1
    }
    this.stagePending = pending
  },
  scheduleCellVisualRedraw() {
    if (this._cellVisualRedrawPending) return
    this._cellVisualRedrawPending = true
    requestAnimationFrame(() => {
      this._cellVisualRedrawPending = false
      M.redraw()
    })
  },
  async magicSubmit(ci) {
    const text = (this.magicInput[ci] ?? '').trim()
    if (!text || !this.canPersist()) return
    let col = this.columns[ci]
    let slug = col?.stage
    if (!slug) {
      const authored = await fetch('/api/stage/from-prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activity: this.actSlug, column: ci, prompt: text, revision: this.act?.revision ?? 0 }),
      })
      if (authored.status === 409) {
        this.markDesync()
        return
      }
      if (authored.ok) {
        const stage = await authored.json()
        this.magicInput[ci] = ''
        await this.loadMeta()
        this.chat.messages.push({ who: 'you', body: text })
        this.chat.messages.push({ who: 'angela', body: stage.summary, events: [] })
        this.showToast(`Angela created ${stage.slug}`)
        return
      }
      slug = slugify(text)
      const columns = copyColumns(this.columns)
      columns[ci] = { stage: slug }
      await fetch(`/api/activity/${this.actSlug}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ columns }) })
      await this.loadMeta()
    }
    this.magicInput[ci] = ''
    this.chatSend(text, { stage: slug, newSession: true })
  },

  // ---- run bar ----
  async play() {
    if (!this.sel.ranges.length) return this.showToast('nothing selected')
    const r = await (await fetch('/api/run/range', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: this.actSlug, range: this.selA1() }) })).json()
    if (r.skipped?.length) this.showToast(`${r.skipped.length} column(s) have no stage — skipped`)
    else this.showToast(`enqueued ${r.added}`)
  },
  async stopAll() { await fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) }) },
  toggleSort(ci) {
    if (this.sort?.ci === ci) this.sort = this.sort.dir === 'asc' ? { ci, dir: 'desc' } : null
    else this.sort = { ci, dir: 'asc' }
    this.refreshWindow(true)
  },

  // ---- rows (filesystem entities) ----
  async addRow() {
    if (!this.canPersist()) return
    const r = await (await fetch('/api/entities', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: this.actSlug }) })).json()
    if (!r.ok) return this.showToast(r.error ?? 'could not add row')
    await this.refreshWindow(false)
    this.showToast(`created ${r.id}.yaml`)
  },
  selectedRowRanges() {
    const ranges = this.sel.ranges
      .map((range) => ({ start: Math.max(0, range.r0), end: Math.min(this.total - 1, range.r1) }))
      .filter((range) => range.start <= range.end)
      .sort((a, b) => a.start - b.start)
    const merged = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end)
      else merged.push(range)
    }
    return merged
  },
  async selectedRows() {
    const rows = new Map()
    for (const range of this.selectedRowRanges()) {
      for (let offset = range.start; offset <= range.end; offset += 500) {
        const limit = Math.min(500, range.end - offset + 1)
        const data = await (await fetch(`/api/entities?${this.entityParams(offset, limit)}`)).json()
        data.rows.forEach((row, index) => rows.set(offset + index, row))
      }
    }
    return rows
  },
  async selectedRowIds() {
    const rows = await this.selectedRows()
    return [...rows.values()].map((row) => row.id)
  },
  async deleteRows() {
    if (!this.canPersist()) return
    if (!this.sel.ranges.length) return this.showToast('select one or more rows first')
    const ids = await this.selectedRowIds()
    if (!ids.length) return this.showToast('no rows selected')
    if (!confirm(`Delete ${ids.length} row${ids.length === 1 ? '' : 's'} and their YAML files from disk?`)) return
    const r = await (await fetch('/api/entities/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activity: this.actSlug, ids }),
    })).json()
    if (!r.ok) return this.showToast(r.error ?? 'could not delete rows')
    this.sel = { ranges: [], active: null, anchor: null }
    const scrollTop = document.querySelector('.gridwrap')?.scrollTop ?? 0
    await this.refreshWindow(false)
    M.redraw()
    requestAnimationFrame(() => {
      const grid = document.querySelector('.gridwrap')
      if (grid) grid.scrollTop = scrollTop
    })
    this.showToast(`deleted ${r.deleted.length} row${r.deleted.length === 1 ? '' : 's'}`)
  },

  // ---- columns (toolbar) ----
  async toggleFieldColumn(f) {
    const columns = copyColumns(this.columns)
    const idx = columns.findIndex((c) => c.field === f)
    if (idx >= 0) columns.splice(idx, 1)
    else columns.push({ field: f })
    await this.patchColumns(columns)
  },
  hasFieldColumn(f) { return this.columns.some((c) => c.field === f) },
  async insertColumn() {
    const at = (this.sel.active?.c ?? this.columns.length - 1) + 1
    const columns = copyColumns(this.columns)
    columns.splice(at, 0, {})
    await this.patchColumns(columns)
  },
  async deleteColumn() {
    const ci = this.sel.active?.c
    if (ci == null) return this.showToast('select a cell in the column first')
    const col = this.columns[ci]
    if (col?.stage && !confirm(`Remove column ${colLetter(ci)}? Stage '${col.stage}' stays available for other activities.`)) return
    const columns = copyColumns(this.columns)
    columns.splice(ci, 1)
    await this.patchColumns(columns)
  },
  async moveColumn(ci, delta) {
    const target = ci + delta
    if (target < 0 || target >= this.columns.length) return
    const columns = copyColumns(this.columns)
    const [column] = columns.splice(ci, 1)
    columns.splice(target, 0, column)
    try {
      await this.patchColumns(columns)
      M.redraw()
    } catch (error) {
      this.showToast(error.message ?? 'could not move column')
    }
  },
  async patchColumns(columns, componentLocks = this.componentLocks) {
    const result = await this.persistActivity({ columns, componentLocks })
    if (!result) return false
    await this.loadMeta(false)
    this.redrawGrid()
    return true
  },
  redrawGrid() {
    const scrollTop = document.querySelector('.gridwrap')?.scrollTop ?? 0
    M.redraw()
    requestAnimationFrame(() => {
      const grid = document.querySelector('.gridwrap')
      if (grid) grid.scrollTop = scrollTop
    })
  },
  componentLocked(component) { return !!this.componentLocks[component] },
  async toggleComponent(group) {
    if (!this.canPersist()) return
    const lock = this.componentLocks[group.component]
    if (!lock) {
      const snapshot = Object.fromEntries(group.fields.map((field) => [field.path, this.hasFieldColumn(field.path)]))
      const added = group.fields.filter((field) => !snapshot[field.path]).map((field) => field.path)
      const columns = copyColumns(this.columns)
      for (const path of added) columns.push({ field: path })
      const locks = { ...this.componentLocks, [group.component]: { snapshot, added } }
      await this.patchColumns(columns, locks)
    } else {
      const forced = new Set(lock.added)
      const columns = this.columns.filter((column) => !forced.has(column.field))
      const locks = { ...this.componentLocks }
      delete locks[group.component]
      await this.patchColumns(columns, locks)
    }
    M.redraw()
  },
  async toggleFieldPath(path) { await this.toggleFieldColumn(path) },
  hasStageColumn(slug) { return this.columns.some((column) => column.stage === slug) },
  async toggleStageColumn(slug) {
    if (!this.canPersist()) return
    const columns = copyColumns(this.columns)
    const index = columns.findIndex((column) => column.stage === slug)
    if (index >= 0) columns.splice(index, 1)
    else columns.push({ stage: slug })
    await this.patchColumns(columns)
  },
  startFieldColumnEdit(ci) {
    const field = this.columns[ci]?.field
    if (!field) return
    this.fieldColumnEdit = { ci, value: field }
    M.redraw()
    setTimeout(() => document.querySelector('.field-path-edit')?.focus(), 0)
  },
  openMagicColumn(ci) {
    const col = this.columns[ci]
    if (col?.stage) location.hash = `#/stage/${col.stage}`
    else this.startFieldColumnEdit(ci)
  },
  fieldColumnEditKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); this.commitFieldColumnEdit() }
    if (e.key === 'Escape') { this.fieldColumnEdit = null; M.redraw() }
  },
  async commitFieldColumnEdit() {
    const edit = this.fieldColumnEdit
    if (!edit) return
    this.fieldColumnEdit = null
    M.redraw()
    const field = edit.value.trim()
    if (field === this.columns[edit.ci]?.field) return
    if (!/^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)+$/.test(field)) return this.showToast('field path must be component.field')
    const columns = copyColumns(this.columns)
    columns[edit.ci] = { field }
    if (!await this.patchColumns(columns)) return
    M.redraw()
    this.showToast(`saved ${field}`)
  },

  // ---- tabs (Δ) ----
  async switchTab(slug) {
    if (slug === this.actSlug) return this.startTabRename(slug)
    this.actSlug = slug
    this.tabMenu = null
    location.hash = `#/a/${slug}`
    await this.refreshWindow(true)
  },
  async addTab() {
    if (!this.canPersist()) return
    const r = await (await fetch('/api/activity', { method: 'POST' })).json()
    await this.loadMeta(false)
    this.switchTab(r.slug)
  },
  toggleTabMenu(slug) {
    this.tabMenu = this.tabMenu === slug ? null : slug
    M.redraw()
  },
  startTabRename(slug) {
    const activity = this.meta?.activities?.find((entry) => entry.slug === slug)
    if (!activity) return
    this.tabRename = { slug, value: activity.title }
    M.redraw()
    setTimeout(() => document.querySelector('.tab-rename-input')?.focus(), 0)
  },
  tabRenameKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); this.commitTabRename() }
    if (e.key === 'Escape') { this.tabRename = null; M.redraw() }
  },
  async commitTabRename() {
    const rename = this.tabRename
    if (!rename) return
    this.tabRename = null
    M.redraw()
    const title = rename.value.trim()
    const activity = this.meta?.activities?.find((entry) => entry.slug === rename.slug)
    if (!title || title === activity?.title) return
    try {
      const result = await this.persistActivity({ title })
      if (!result) return
      await this.loadMeta()
      M.redraw()
      this.showToast(`renamed activity to ${title}`)
    } catch (error) {
      this.showToast(error.message ?? 'could not rename activity')
    }
  },
  async deleteTab(slug) {
    if (!this.canPersist()) return
    const activity = this.meta?.activities?.find((entry) => entry.slug === slug)
    if (!activity || !confirm(`Delete activity '${activity.title}' and its activity YAML file?`)) return
    const response = await fetch(`/api/activity/${encodeURIComponent(slug)}?revision=${this.act?.revision ?? 0}`, { method: 'DELETE' })
    const result = await response.json()
    if (response.status === 409) return this.markDesync()
    if (!response.ok || !result.ok) return this.showToast(result.error ?? 'could not delete activity')
    this.tabMenu = null
    if (this.actSlug === slug) {
      this.actSlug = this.meta.activities.find((entry) => entry.slug !== slug)?.slug ?? null
      location.hash = this.actSlug ? `#/a/${this.actSlug}` : ''
    }
    await this.loadMeta()
    this.showToast(`deleted ${activity.title}`)
  },
  queuePersistedReload(ev) {
    const key = ev.resource === 'entity' ? `entity:${ev.source ?? ''}` : `${ev.resource}:${ev.slug ?? ''}`
    if (this.persistTimers[key]) return
    this.persistTimers[key] = setTimeout(async () => {
      delete this.persistTimers[key]
      try {
        await this.reloadPersisted(ev)
      } catch (error) {
        this.showToast(error.message ?? 'could not reload persisted data')
      }
    }, 80)
  },
  async reloadPersisted(ev) {
    if (ev.resource === 'activity') {
      return
    } else if (ev.resource === 'stage') {
      delete this.viewMods[ev.slug]
      await this.refreshWindow(false)
      this.redrawGrid()
    } else if (ev.resource === 'entity') {
      if (ev.source && this.act?.source && ev.source !== this.act.source) return
      await this.refreshWindow(false)
      this.redrawGrid()
    }
  },

  async blankSelection() {
    if (!this.canPersist()) return
    const cells = this.selectedCellCoords()
    if (!cells.length) return
    const rows = await this.selectedRows()
    const byId = new Map()
    for (const [rowIndex, columnIndex] of cells) {
      const row = rows.get(rowIndex)
      const column = this.columns[columnIndex]
      if (!row || !column) continue
      let fields = []
      if (column.field) fields = [column.field]
      else if (column.stage) {
        const meta = await this.stageMeta(column.stage)
        fields = meta?.writes ?? []
      }
      if (!fields.length) continue
      if (!byId.has(row.id)) byId.set(row.id, new Set())
      fields.forEach((field) => byId.get(row.id).add(field))
    }
    if (!byId.size) return
    const items = [...byId].map(([id, fields]) => ({ id, fields: [...fields] }))
    const response = await fetch('/api/entities/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activity: this.actSlug, items }) })
    const result = await response.json()
    if (!response.ok || !result.ok) return this.showToast(result.error ?? 'could not blank cells')
    await this.refreshWindow(false)
    this.redrawGrid()
    this.showToast(`blanked ${result.blanked} value${result.blanked === 1 ? '' : 's'}`)
  },

  // ---- websocket ----
  connectWS() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/run`)
    ws.onopen = () => { this.wsConnected = true; M.redraw() }
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data)
      if (ev.type === 'queue') { this.q = ev; if (!this.dragging) this.conc = ev.concurrency }
      else if (ev.type === 'cells') {
        this.cellStates = Object.fromEntries(ev.cells.map((cell) => [`${cell.id}|${cell.stage}`, cell]))
        this.syncStagePending()
        this.scheduleCellVisualRedraw()
      }
      else if (ev.type === 'cell') {
        this.cellStates = { ...this.cellStates, [`${ev.entity}|${ev.stage}`]: { state: ev.state, error: ev.error } }
        this.syncStagePending()
        this.scheduleCellVisualRedraw()
      }
      else if (ev.type === 'queue-cleared') { this.cellStates = {}; this.stagePending = {}; M.redraw() }
      else if (ev.type === 'log') this.pushLog(ev)
      else if (ev.type === 'persisted') this.queuePersistedReload(ev)
    }
    ws.onclose = () => {
      this.wsConnected = false
      M.redraw()
      setTimeout(() => this.connectWS(), 2000)
    }
  },
  pushLog(ev) {
    this.logs.push(ev)
    if (this.logs.length > 500) this.logs.shift()
    if (this.logPinned) requestAnimationFrame(() => {
      const el = document.querySelector('.logbox')
      if (!el || !this.logPinned) return
      el.scrollTop = el.scrollHeight
      this._lastLogTop = el.scrollTop
    })
  },
  logScroll(e) {
    const el = e.currentTarget
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (el.scrollTop < this._lastLogTop) {
      this.logPinned = false
    } else if (distance <= 32) {
      this.logPinned = true
    }
    this._lastLogTop = el.scrollTop
  },
  logWheel(e) { if (e.deltaY < 0) this.logPinned = false },
  logHtml(ev) {
    const ts = new Date(ev.ts).toTimeString().slice(0, 8)
    return `<span class="ts">${ts}</span> <span style="color:${hashColor(ev.stage)}">${esc(ev.stage)}</span> <span style="color:${hashColor(ev.entity)}">${esc(ev.entity)}</span> ${esc(ev.line)}`
  },

  // ---- queue bar (Ζ) + slider (Η) ----
  qSeg(state) {
    const total = this.q.queued + this.q.idle + this.q.running + this.q.done + this.q.error
    return total ? `width:${(this.q[state] / total) * 100}%` : 'width:0'
  },
  get qSummary() {
    const t = this.q.queued + this.q.idle + this.q.running + this.q.done + this.q.error
    return t ? `${this.q.done + this.q.error}/${t}` : '—'
  },
  async clearQueue() {
    const total = this.q.queued + this.q.idle + this.q.running + this.q.done + this.q.error
    if (!total) return
    const response = await fetch('/api/queue/clear', { method: 'POST' })
    const result = await response.json()
    if (!response.ok || !result.ok) return this.showToast(result.error ?? 'could not clear queue')
    this.cellStates = {}
    this.stagePending = {}
    M.redraw()
    this.showToast('queue cleared')
  },
  async pauseQueue() {
    if (!this.q.running) return
    const response = await fetch('/api/queue/concurrency', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 0 }) })
    const result = await response.json()
    if (!response.ok || !result.ok) return this.showToast(result.error ?? 'could not pause queue')
    this.showToast('queue paused')
  },
  sliderDown(e) {
    this.dragging = { x: e.clientX, v: this.conc }
    const move = (ev) => { if (this.dragging) { this.conc = Math.max(0, Math.min(64, Math.round(this.dragging.v + (ev.clientX - this.dragging.x) / 3))); M.redraw() } }
    const up = async () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      const n = this.conc; this.dragging = null
      await fetch('/api/queue/concurrency', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }) })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  },

  // ---- chat (Ε/Θ) ----
  focusedStage() {
    if (this.focus) return this.focus.slug
    const c = this.sel.active?.c
    return c != null ? this.columns[c]?.stage ?? null : null
  },
  async chatSend(text, opts = {}) {
    text = text ?? this.chat.input.trim()
    if (!text || this.chat.busy) return
    this.chat.input = ''
    this.chat.messages.push({ who: 'you', body: text })
    const asst = { who: 'angela', body: '', events: [] }
    this.chat.messages.push(asst)
    this.chat.busy = true
    try {
      const sample = this.rows[0]?.doc ?? null
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, activity: this.actSlug, selection: this.selA1() || null, stage: opts.stage ?? this.focusedStage(), entitySample: sample, newSession: opts.newSession ?? false }) })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let ev; try { ev = JSON.parse(line) } catch { continue }
          if (ev.type === 'assistant_delta') asst.body += ev.text
          else if (ev.type === 'error') asst.body += `\n⚠ ${ev.error}`
          else if (ev.type === 'event' && ev.event?.type === 'tool_call') asst.events.push(`⚙ ${ev.event.name ?? 'tool'}`)
          else if (ev.type === 'done' && !asst.body) asst.body = ev.text ?? ''
          M.redraw()
          const el = document.querySelector('.chat .messages'); if (el) el.scrollTop = el.scrollHeight
        }
      }
    } catch (e) {
      asst.body += `\n⚠ ${e.message}`
    } finally {
      this.chat.busy = false
    }
  },
  chatKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.chatSend() } },

  // ---- focus mode (§9) ----
  async openFocus(slug) {
    const st = await (await fetch(`/api/stage/${slug}`)).json()
    this.focus = { slug, source: st.source ?? '', meta: st.meta, results: null, busy: false }
  },
  closeFocus() { location.hash = `#/a/${this.actSlug ?? ''}` },
  async saveStage() {
    if (!this.canPersist()) return
    await fetch(`/api/stage/${this.focus.slug}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: this.focus.source }) })
    this.showToast('saved')
  },
  async benchRun(n) {
    this.focus.busy = true
    try {
      const ids = this.rows.slice(0, n).map((r) => r.id)
      const r = await (await fetch('/api/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activity: this.actSlug, stage: this.focus.slug, ids }) })).json()
      this.focus.results = r.ok ? r.results : [{ id: '(error)', ok: false, error: r.error }]
    } finally { this.focus.busy = false }
  },
  benchHtml(r) {
    if (!r.ok) return `<div class="r-err">✗ ${esc(r.id)}: ${esc(r.error)}</div>`
    let out = `<div class="r-ok">✓ ${esc(r.id)} ${r.gate === false ? '(gate: false)' : ''}</div>`
    out += `<div>${esc(JSON.stringify(r.patch))}</div>`
    for (const l of r.log ?? []) out += `<div style="color:var(--dim)">· ${esc(l)}</div>`
    return out
  },

  showToast(msg) { this.toast = msg; clearTimeout(this._toastT); this._toastT = setTimeout(() => { this.toast = '' }, 2500) },

  // ---- template ----
  template: `
  <div class="layout">
    <div class="main">
      <div class="toolbar">
        <span class="dot" :class="desynced ? 'desync' : (wsConnected ? 'on' : '')" :title="desynced ? 'desynchronized: reload persistent files before saving' : (wsConnected ? 'connected to sheets server' : 'disconnected from sheets server')" x-text="desynced ? '!' : ''"></span><span class="desync-label" x-show="desynced">desync</span><span class="title">sheets</span><button class="refresh-button" @click="refreshPersistent()" title="reload persistent files">↻</button>
        <span x-text="meta ? meta.root.split('/').pop() : ''" style="color:var(--dim)"></span>
        <div class="dropdown" @click.outside="fieldMenu = false">
          <button @click="fieldMenu = !fieldMenu">columns ▾</button>
          <div class="menu" x-show="fieldMenu">
            <div class="column-group-heading">Stages</div>
            <label class="stage-toggle" x-for="stage in stageTree" :key="stage.slug">
              <input type="checkbox" :checked="hasStageColumn(stage.slug)" @change="toggleStageColumn(stage.slug)">
              <span x-text="stage.title"></span>
            </label>
            <div class="column-group-heading">Component fields</div>
            <div class="component-group" x-for="group in fieldTree" :key="group.component">
              <label class="component-toggle">
                <input type="checkbox" :checked="componentLocked(group.component)" @change="toggleComponent(group)">
                <span x-text="group.component"></span>
              </label>
              <label class="field-toggle" x-for="field in group.fields" :key="field.path">
                <input type="checkbox" :checked="hasFieldColumn(field.path)" :disabled="componentLocked(group.component)"
                  @change="toggleFieldPath(field.path)">
                <span x-text="field.name"></span>
              </label>
            </div>
          </div>
        </div>
        <button @click="addRow()" title="create a new entity YAML row">+ row</button>
        <button @click="deleteRows()" title="delete rows included in the selection">− row</button>
        <button @click="insertColumn()" title="insert stage column after cursor">+ col</button>
        <button @click="deleteColumn()" title="delete column at cursor">− col</button>
        <input placeholder="search…" x-model="search" @keydown="if ($event.key === 'Enter') refreshWindow(true)" style="width:130px">
        <button class="primary" @click="play()" title="run selection">▶ play</button>
        <span class="sel-readout" x-text="selReadout"></span>
      </div>

      <div class="focus" x-show="focus">
        <div class="pane meta" x-show="focus">
          <h3>stage: <span x-text="focus ? focus.slug : ''"></span></h3>
          <div class="kv" x-text="focus && focus.meta ? 'title: ' + (focus.meta.title || '') : ''"></div>
          <div class="kv" x-text="focus && focus.meta && focus.meta.prompt ? 'prompt: ' + focus.meta.prompt : ''"></div>
          <div class="kv" x-text="focus && focus.meta && focus.meta.writes ? 'writes: ' + focus.meta.writes.join(', ') : ''"></div>
          <button @click="closeFocus()">← back to sheet</button>
        </div>
        <div class="code" x-show="focus">
          <div style="padding:6px 10px;border-bottom:1px solid var(--border)">
            <button class="primary" @click="saveStage()">save</button>
            <span style="color:var(--dim);font-size:11px">saving hot-reloads the stage; edits from Angela/your IDE appear live</span>
          </div>
          <textarea x-model="focus.source" spellcheck="false"></textarea>
        </div>
        <div class="pane bench" x-show="focus">
          <h3>test bench (dry-run, never persists)</h3>
          <div style="margin-bottom:6px">
            <button @click="benchRun(1)" :disabled="focus && focus.busy">▶ 1 entity</button>
            <button @click="benchRun(5)" :disabled="focus && focus.busy">▶ 5</button>
            <span class="spin" x-show="focus && focus.busy">⟳</span>
          </div>
          <div class="results">
            <div x-for="r, i in (focus && focus.results) || []" :key="i" x-html="benchHtml(r)" style="margin-bottom:8px"></div>
          </div>
        </div>
      </div>

      <div class="gridwrap" x-show="!focus" @scroll="onScroll()" @mouseup="cellUp()">
        <table class="grid">
          <thead>
            <tr>
              <th class="corner rowhead"><span style="color:var(--dim)" x-text="total + ' rows'"></span></th>
              <th class="colhead" x-for="col, ci in columns" :key="col.stage || col.field || 'empty-' + ci" :class="colSelected(ci) ? 'selected-head' : ''" @click="colHeadClick(ci, $event)"
                :title="'click: select column · alt-click: sort'">
                <span class="letter" x-text="colLetter(ci)"></span>
                <span x-text="sort && sort.ci === ci ? (sort.dir === 'asc' ? '↑' : '↓') : ''"></span>
              </th>
            </tr>
            <tr class="magic">
              <th class="rowhead"></th>
              <th x-for="col, ci in columns" :key="col.stage || col.field || 'empty-' + ci">
                <div class="magic-cell" :class="colRunning(ci) > 0 ? 'processing' : ''">
                  <input class="field-path-edit" x-show="col.field && fieldColumnEdit && fieldColumnEdit.ci === ci"
                    :value="fieldColumnEdit && fieldColumnEdit.ci === ci ? fieldColumnEdit.value : ''"
                    @input="fieldColumnEdit.value = $event.target.value" @keydown="fieldColumnEditKey($event)" @blur="commitFieldColumnEdit()">
                  <template x-if="magicTitle(ci) !== null">
                    <span class="mtitle" :class="col.stage ? 'stage' : 'field'"
                      x-show="!col.field || !fieldColumnEdit || fieldColumnEdit.ci !== ci" x-text="magicTitle(ci)"
                      @click="openMagicColumn(ci)"></span>
                  </template>
                  <template x-if="magicTitle(ci) === null">
                    <input placeholder="describe this stage…" :value="magicInput[ci] || ''" @input="magicInput[ci] = $event.target.value"
                      @keydown="if ($event.key === 'Enter') magicSubmit(ci)">
                  </template>
                  <span class="actions">
                    <button title="move column left" :disabled="ci === 0" @click.stop="moveColumn(ci, -1)">‹</button>
                    <button title="move column right" :disabled="ci === columns.length - 1" @click.stop="moveColumn(ci, 1)">›</button>
                    <button x-show="!col.stage && magicInput[ci]" @click="magicSubmit(ci)" title="send to Angela">✨</button>
                  </span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr x-show="topPad > 0"><td :colspan="columns.length + 1" :style="'height:' + topPad + 'px;padding:0;border:0'"></td></tr>
            <tr x-for="row, i in rows" :key="row.id">
              <td class="rowhead" :class="rowSelected(i) ? 'selected-head' : ''" @click="rowHeadClick(i, $event)">
                <span class="rownum" x-text="winStart + i + 1"></span>
                <input class="row-rename-input" x-show="renaming && renaming.id === row.id" x-model="renaming.value"
                  @keydown="renameKey($event)" @blur="commitRename()" :title="row.id">
                <span class="rowlabel" x-show="!renaming || renaming.id !== row.id" x-text="row.label" :title="row.id"
                  @click.stop="startRename(i)"></span>
              </td>
              <td x-for="col, ci in columns" :key="col.stage || col.field || 'empty-' + ci" :data-r="i" :data-c="ci"
                :class="(inSel(i, ci) ? 'sel ' : '') + (isActive(i, ci) ? 'active ' : '') + cellStateClass(row, ci)"
                @mousedown="cellDown(i, ci, $event)" @mouseover="cellOver(i, ci, $event)"
                @dblclick="cellDbl(i, ci)"
                x-html="cellHtml(row, ci)"></td>
            </tr>
            <tr x-show="bottomPad > 0"><td :colspan="columns.length + 1" :style="'height:' + bottomPad + 'px;padding:0;border:0'"></td></tr>
          </tbody>
        </table>
      </div>

      <div class="tabs">
        <div class="tab" x-for="a in (meta && meta.activities) || []" :key="a.slug"
          :class="a.slug === actSlug ? 'on' : ''" @click="switchTab(a.slug)" @click.outside="tabMenu = null">
          <input class="tab-rename-input" x-show="tabRename && tabRename.slug === a.slug"
            :value="tabRename && tabRename.slug === a.slug ? tabRename.value : ''" @input="tabRename.value = $event.target.value"
            @click.stop @keydown="tabRenameKey($event)" @blur="commitTabRename()">
          <span class="tab-label" x-show="!tabRename || tabRename.slug !== a.slug" x-text="a.title"></span>
          <button class="tab-menu" title="activity options" @click.stop="toggleTabMenu(a.slug)">⌄</button>
          <div class="tab-context" x-show="tabMenu === a.slug">
            <button @click.stop="deleteTab(a.slug)">delete</button>
          </div>
        </div>
        <div class="tab add-tab" title="add activity" @click="addTab()">+</div>
      </div>
    </div>

    <div class="sidebar">
      <div class="queuebox">
        <div class="qbar">
          <div :style="qSeg('done') + ';background:var(--done)'"></div>
          <div :style="qSeg('running') + ';background:var(--running)'"></div>
          <div :style="qSeg('idle') + ';background:var(--idle)'"></div>
          <div :style="qSeg('queued') + ';background:var(--queued)'"></div>
          <div :style="qSeg('error') + ';background:var(--error)'"></div>
        </div>
        <div class="qmeta">
          <span x-text="qSummary"></span>
          <button class="queue-clear" @click="clearQueue()" :disabled="q.queued + q.idle + q.running + q.done + q.error === 0" title="clear queue">×</button>
          <span x-text="'run:' + q.running + ' err:' + q.error"></span>
          <span style="margin-left:auto">concurrency</span>
          <button class="queue-pause" x-show="q.running > 0" @click="pauseQueue()" title="pause queue">Ⅱ</button>
          <div class="slider" @pointerdown="sliderDown($event)">
            <div class="fill" :style="'width:' + Math.max(2, conc / 64 * 100) + '%'"></div>
            <div class="val" x-text="conc"></div>
          </div>
        </div>
      </div>
      <div class="logbox" @scroll="logScroll($event)" @wheel="logWheel($event)">
        <div x-for="ev, i in logs" :key="i" x-html="logHtml(ev)"></div>
      </div>
      <div class="chat">
        <div class="disabled" x-show="!chat.enabled">Angela chat is off — run <b>sheets init</b> in this workspace to scaffold .angela/agents/angela.coffee, then restart the server.</div>
        <div class="messages" x-show="chat.enabled">
          <div class="msg" x-for="m, i in chat.messages" :key="i" :class="m.who === 'you' ? 'user' : ''">
            <div class="who" x-text="m.who"></div>
            <div class="ev" x-for="e, j in m.events || []" :key="j" x-text="e"></div>
            <div class="body" x-text="m.body"></div>
          </div>
        </div>
        <div class="composer" x-show="chat.enabled">
          <textarea rows="2" placeholder="ask Angela… (selection context attaches automatically)"
            x-model="chat.input" @keydown="chatKey($event)"></textarea>
          <button class="primary" @click="chatSend()" :disabled="chat.busy" x-text="chat.busy ? '…' : '➤'"></button>
        </div>
      </div>
    </div>
  </div>
  <div class="toast" x-show="toast" x-text="toast"></div>
  <div class="overlay-edit" x-show="editing" :style="editing ? 'position:fixed;z-index:60;left:' + editing.x + 'px;top:' + editing.y + 'px;width:' + editing.w + 'px' : ''">
    <input x-model="editing.value" @keydown="editKey($event)" @blur="commitEdit()" style="width:100%">
  </div>
  `,
  colLetter,
}))
