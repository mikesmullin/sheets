// sheets SPA (§6). Local m-js distribution symlinked from /workspace/m-js/dist/m.js.
// Layout per Wireframe A: toolbars (Α), column letters (Κ), row rail (Λ), magic row (Β),
// cells (Γ), selection (Ι), activity tabs (Δ), queue (Ζ), slider (Η), run log (Μ),
// Angela chat (Ε/Θ). Stage focus mode (§9) at #/stage/<slug>.
import M from './m.js'
import './hot-client.js'

const ROWH = 40
const MIN_ROW_HEIGHT = 22
const MAX_ROW_HEIGHT = 480
const DEFAULT_COL_WIDTH = 180
const MIN_COL_WIDTH = 60
const MAX_COL_WIDTH = 960
// Virtual scroll uses ROWH only to estimate the rendered window and spacers.
// Rendered rows always retain their natural content height.
const V_OVERSCAN = 32          // rows above/below viewport (fling headroom)
const V_FULL_LOAD_MAX = 500    // one response remains bounded; larger sheets window rows
const V_SCROLL_IDLE_MS = 160   // after this quiet period, flush deferred redraws
const normalizeRowHeight = (height) => {
  const n = Math.round(Number(height))
  if (!Number.isFinite(n)) return ROWH
  return Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, n))
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const colLetter = (i) => { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26 } return s }
const hashColor = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return `hsl(${Math.abs(h) % 360},55%,62%)` }
const getPath = (doc, p) => { let c = doc; for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return undefined; c = c[k] } return c }
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stage'
const copyColumns = (columns) => columns.map((column) => ({ ...column }))
// Column filters are a per-user view preference, not sheet structure — they live in
// localStorage so they never dirty the activity YAML or bump its revision.
const COL_FILTER_KEY = 'sheets-col-filters'
const COLLAPSED_ROWS_KEY = 'sheets-collapsed-row-ids'
const escapeRe = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normalizeColWidth = (width) => {
  const n = Math.round(Number(width))
  if (!Number.isFinite(n)) return DEFAULT_COL_WIDTH
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, n))
}

function createApp() {
  return {
  // ---- state ----
  meta: null, actSlug: null, total: 0, rows: [], winStart: 0, fields: [], fieldTree: [], stageTree: [], componentLocks: {},
  usePagination: true, page: 0, pageSize: 10,
  // Virtual window: bodyOffsetY positions rendered rows via transform; totalBodyH is the rock-solid spacer.
  bodyOffsetY: 0, totalBodyH: 0,
  sel: { ranges: [], active: null, anchor: null },
  cellStates: {}, stagePending: {}, viewMods: {}, viewLoading: {},
  wsConnected: false, wsConnecting: false,
  desynced: false,
  q: { queued: 0, idle: 0, running: 0, done: 0, error: 0, concurrency: 0 },
  logs: [], conc: 0, dragging: null,
  persistTimers: {},
  logPinned: true, logWrap: false,
  logFilterDraft: '', // live input in log header
  logFilterRe: '', // applied regex source (empty = show all)
  _logFilterDebounce: null,
  _logProgrammaticScroll: false, _logStickPending: false,
  sidebarWidth: 0, logHeight: 180, resizing: false,
  colResize: null, // { ci, width, startX, startW, moved }
  rowHeights: {}, // session-only id -> px; not persisted
  collapsedRowIds: {}, // local preference: id -> true
  rowResize: null, // { id, startY, startH, moved }
  jsonExpanded: {}, // session-only cell|branch -> true; nested JSON stays lazy by default
  chat: {
    enabled: false, messages: [], input: '', busy: false, elapsed: '', startedAt: 0, timer: null, stopRequested: false,
    agents: [], agent: '', models: [], model: '', reasoningEffort: 'medium', thinking: false,
    allowlist: '', allowlistBaseline: '', allowlistOpen: false, allowlistOverridden: false,
    tools: [], toolsEnabled: null, toolsBaseline: null, toolsOpen: false, toolsLoading: false,
    toolsError: '', toolsEnabledOverridden: false, contextWindow: 32768, tokensUsed: 0,
    speak: false, speakWarning: false,
  },
  editing: null, // {r, ci, value, x, y, w} field overlay edit
  stageEditing: null, // stage-owned interactive edit: { stage, id, r, ci }
  _stageMounts: null, // Map cellKey -> { el, slug, unmount?, id }
  renaming: null, // {id, value}
  magicInput: {}, fieldColumnEdit: null, // ci -> draft prompt / {ci, value}
  sort: null, // {ci, dir: 'asc'|'desc'} — user A–Z / Z–A; overrides stage.sort
  colFilters: {}, // ci -> regex string (applied server-side on column values)
  colFilterNot: {}, // ci -> true when the column filter is inverted (NOT)
  colFilterPicks: {}, // ci -> [exact cell texts] chosen from the top-values checkboxes
  filterValues: { ci: null, loading: false, items: [], sampled: 0, distinct: 0 },
  filterMenu: null, // { ci } when open
  filterDraft: '', // live input in open filter menu
  _filterDebounce: null,
  _colValuePath: {}, // ci -> resolved field path (field or stage writes[0])
  search: '', // applied global regex (empty = no search)
  searchDraft: '', // live toolbar search input
  _searchDebounce: null,
  focus: null, // {slug, source, meta, results, busy}
  stageEditor: null, // { key, inputId, component } — stage-owned MJS component in the root outlet
  toast: '', tabMenu: null, tabRename: null,
  fieldMenu: false, columnPickerFilter: '',

  // ---- derived ----
  get act() { return this.meta?.activities?.find((a) => a.slug === this.actSlug) ?? this.meta?.activities?.[0] ?? null },
  get refreshCount() { return M.refreshCount },
  get throttledRefreshCount() { return M.throttledRefreshCount },
  get pageCount() { return Math.max(1, Math.ceil((this.total || 0) / this.pageSize)) },
  get pageLabel() { return `${Math.min(this.page + 1, this.pageCount)} / ${this.pageCount}` },
  // Full ordered catalog (includes hidden). Grid/A1 use `columns` (visible only).
  get fullColumns() { return this.act?.columns ?? [] },
  get columns() { return this.fullColumns.filter((c) => !c.hidden) },
  get columnPickerNeedle() { return this.columnPickerFilter.trim().toLowerCase() },
  // Thinking/brain toggle is only meaningful for gemma models (e.g. lm-studio:google/gemma-4-12b-qat).
  get chatModelSupportsThinking() { return /:.*gemma/i.test(this.chat.model ?? '') },
  get filteredStages() {
    const needle = this.columnPickerNeedle
    if (!needle) return this.stageTree ?? []
    return (this.stageTree ?? []).filter((stage) => `${stage.title ?? ''} ${stage.slug ?? ''}`.toLowerCase().includes(needle))
  },
  get filteredFieldTree() {
    const needle = this.columnPickerNeedle
    if (!needle) return this.fieldTree ?? []
    return (this.fieldTree ?? []).flatMap((group) => {
      const componentMatches = group.component.toLowerCase().includes(needle)
      const fields = componentMatches ? group.fields : group.fields.filter((field) => `${field.name} ${field.path}`.toLowerCase().includes(needle))
      return fields.length ? [{ ...group, fields }] : []
    })
  },
  get filteredFieldCount() { return this.filteredFieldTree.reduce((count, group) => count + group.fields.length, 0) },
  // Map a visible column index to an index in fullColumns.
  fullIndexFromVisible(vi) {
    let v = 0
    const full = this.fullColumns
    for (let i = 0; i < full.length; i++) {
      if (full[i].hidden) continue
      if (v === vi) return i
      v++
    }
    return -1
  },
  // Insert position in fullColumns for a new column that should appear at visible index `at`.
  fullInsertIndex(at) {
    const full = this.fullColumns
    if (at >= this.columns.length) return full.length
    let v = 0
    for (let i = 0; i < full.length; i++) {
      if (full[i].hidden) continue
      if (v === at) return i
      v++
    }
    return full.length
  },
  setColumnHidden(col, hidden) {
    if (hidden) col.hidden = true
    else delete col.hidden
  },

  async init() {
    // Full m-js redraw destroys #app (including .gridwrap) and kills scroll momentum.
    // Wrap redraw to (1) restore scrollTop and (2) defer redraws while the user is
    // actively flinging the grid — that destroy/recreate cycle is the main recoil.
    if (!M._sheetsScrollWrap) {
      M._sheetsScrollWrap = true
      const rawRedraw = M.redraw.bind(M)
      const self = this
      M.redraw = (options = {}) => {
        const force = options?.force === true || self._forceRedraw === true
        if (self._isGridScrollHot() && !self._preservingScroll && !force) {
          self._pendingRedraw = true
          self._scheduleScrollIdleFlush()
          return
        }
        self.preserveUiScroll(() => rawRedraw(force ? { ...options, force: true } : options))
        self.scheduleStageMounts()
      }
    }
    this.loadChatPrefs()
    this.loadColumnPickerFilter()
    this.loadCollapsedRows()
    // Keep the page restored from localStorage on the initial worksheet load.
    // Later filter/sort/tab changes still deliberately reset to page one.
    await this.loadMeta(false)
    this.connectWS()
    window.addEventListener('keydown', (e) => this.globalKey(e))
    window.addEventListener('hashchange', () => this.route())
    this.route()
  },
  // True while the user is mid-gesture on the grid (wheel/trackpad/thumb).
  _isGridScrollHot() {
    const at = this._gridUserScrollAt ?? 0
    return at > 0 && (performance.now() - at) < V_SCROLL_IDLE_MS
  },
  _scheduleScrollIdleFlush() {
    if (this._scrollIdleTimer) clearTimeout(this._scrollIdleTimer)
    this._scrollIdleTimer = setTimeout(() => {
      this._scrollIdleTimer = 0
      this._flushScrollIdle()
    }, V_SCROLL_IDLE_MS)
  },
  _flushScrollIdle() {
    if (this._isGridScrollHot()) {
      this._scheduleScrollIdleFlush()
      return
    }
    // Apply deferred virtual-window commit first (state only), then one redraw.
    if (this._pendingWindow && this._pendingAssembled) {
      this.winStart = this._pendingFirst ?? 0
      this.rows = this._pendingAssembled
      this.bodyOffsetY = this.winStart * ROWH
      this._pendingAssembled = null
      this._pendingFirst = null
      this._pendingWindow = false
      this._pendingRedraw = true
    }
    const needRedraw = this._pendingRedraw
    const needWindow = this._scrollDirty
    this._pendingRedraw = false
    this._scrollDirty = false
    if (needWindow && !(this._fullLoaded && this._canFullLoad())) {
      this.ensureWindow({ reset: false })
    }
    if (needRedraw) {
      this._forceRedraw = true
      try { M.redraw() } finally { this._forceRedraw = false }
      // The pending virtual-window path updates rows here rather than through
      // _commitWindow, so it must explicitly mount the freshly redrawn cells.
      this.scheduleStageMounts()
    }
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
        this.loadPaginationPrefs()
        this.restoreColFilters()
        this.refreshWindow(true)
      } else if (a[1] !== this.actSlug) {
        this.actSlug = a[1]
        this.loadPaginationPrefs()
        this.restoreColFilters()
        this.refreshWindow(true)
      }
    }
  },

  async loadMeta(resetWindow = true) {
    this.meta = await (await fetch('/api/meta')).json()
    this.chat.enabled = this.meta.chat
    if (this.chat.enabled) await this.loadChatConfig()
    if (!this.actSlug) this.actSlug = this.meta.activities[0]?.slug ?? null
    this.loadPaginationPrefs()
    this._colValuePath = {}
    this.restoreColFilters()
    await this.refreshWindow(resetWindow)
    const [fieldData, stageData] = await Promise.all([
      fetch(`/api/fields?activity=${this.actSlug}`).then((response) => response.json()),
      fetch('/api/stages').then((response) => response.json()),
    ])
    this.fields = fieldData.fields
    // components[].fields may be string names (legacy) or { name, path, inSchema }
    this.fieldTree = fieldData.components.map((group) => ({
      component: group.component,
      fields: (group.fields ?? []).map((entry) => {
        if (entry && typeof entry === 'object') {
          return {
            name: entry.name,
            path: entry.path ?? `${group.component}.${entry.name}`,
            inSchema: entry.inSchema === true,
          }
        }
        return { name: entry, path: `${group.component}.${entry}`, inSchema: false }
      }),
    }))
    this.stageTree = stageData.stages
    this.componentLocks = this.act?.componentLocks ?? {}
  },
  async reloadFieldTree() {
    const fieldData = await (await fetch(`/api/fields?activity=${this.actSlug}`)).json()
    this.fields = fieldData.fields
    this.fieldTree = fieldData.components.map((group) => ({
      component: group.component,
      fields: (group.fields ?? []).map((entry) => {
        if (entry && typeof entry === 'object') {
          return {
            name: entry.name,
            path: entry.path ?? `${group.component}.${entry.name}`,
            inSchema: entry.inSchema === true,
          }
        }
        return { name: entry, path: `${group.component}.${entry}`, inSchema: false }
      }),
    }))
    M.redraw()
  },
  async toggleFieldMenu() {
    this.fieldMenu = !this.fieldMenu
    if (this.fieldMenu) {
      // Refresh discovery so newly written fields (e.g. animal.noise) appear.
      try { await this.reloadFieldTree() } catch { /* keep prior tree */ }
      try {
        const stageData = await (await fetch('/api/stages')).json()
        this.stageTree = stageData.stages
      } catch { /* keep prior stages */ }
    }
    M.redraw()
  },
  loadColumnPickerFilter() {
    try { this.columnPickerFilter = localStorage.getItem('sheets-column-picker-filter') ?? '' } catch { /* storage unavailable */ }
  },
  paginationPrefsKey() { return `sheets-pagination:${this.actSlug ?? 'default'}` },
  loadPaginationPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.paginationPrefsKey()) || 'null')
      const page = Number(saved?.page ?? localStorage.getItem('sheets-page'))
      const pageSize = Number(saved?.pageSize ?? localStorage.getItem('sheets-page-size'))
      if (Number.isInteger(page) && page >= 0) this.page = page
      if ([5, 10, 25, 50, 100].includes(pageSize)) this.pageSize = pageSize
    } catch { /* storage unavailable */ }
  },
  savePaginationPrefs() {
    try {
      localStorage.setItem(this.paginationPrefsKey(), JSON.stringify({ page: this.page, pageSize: this.pageSize }))
      localStorage.setItem('sheets-page', String(this.page))
      localStorage.setItem('sheets-page-size', String(this.pageSize))
    } catch { /* storage unavailable */ }
  },
  loadCollapsedRows() {
    try {
      const ids = JSON.parse(localStorage.getItem(COLLAPSED_ROWS_KEY) || '[]')
      if (Array.isArray(ids)) this.collapsedRowIds = Object.fromEntries(ids.filter((id) => typeof id === 'string').map((id) => [id, true]))
    } catch { /* storage unavailable or malformed preference */ }
  },
  saveCollapsedRows() {
    try { localStorage.setItem(COLLAPSED_ROWS_KEY, JSON.stringify(Object.keys(this.collapsedRowIds))) } catch { /* storage unavailable */ }
  },
  setColumnPickerFilter(value) {
    this.columnPickerFilter = String(value ?? '')
    try { localStorage.setItem('sheets-column-picker-filter', this.columnPickerFilter) } catch { /* storage unavailable */ }
  },
  async toggleSchemaField(field) {
    if (!this.canPersist()) return
    const action = field.inSchema ? 'remove' : 'add'
    const label = field.inSchema
      ? `Remove ${field.path} from schema.yaml?`
      : `Add ${field.path} to schema.yaml (type guessed from entity values)?`
    if (!confirm(label)) return
    const r = await (await fetch('/api/fields/schema', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: this.actSlug, field: field.path, action }),
    })).json()
    if (!r.ok) return this.showToast(r.error ?? 'schema update failed')
    await this.reloadFieldTree()
    this.showToast(action === 'add' ? `schema + ${field.path} (${r.type ?? 'string'})` : `schema − ${field.path}`)
  },
  async deleteFieldEverywhere(field) {
    if (!this.canPersist()) return
    if (!confirm(`Delete field ${field.path} from ALL entities in this dataset?\n\nThis cannot be undone.`)) return
    const r = await (await fetch('/api/fields/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: this.actSlug, field: field.path }),
    })).json()
    if (!r.ok) return this.showToast(r.error ?? 'field delete failed')
    // Drop field from ordered catalog (not just hide)
    if (this.fullColumns.some((c) => c.field === field.path)) {
      const columns = copyColumns(this.fullColumns).filter((c) => c.field !== field.path)
      await this.patchColumns(columns)
    }
    await this.reloadFieldTree()
    await this.refreshWindow(false)
    this.showToast(`removed ${field.path} from ${r.changed} entit${r.changed === 1 ? 'y' : 'ies'}`)
  },
  async deleteStageFile(stage) {
    if (!this.canPersist()) return
    const slug = stage.slug ?? stage
    if (!confirm(`Delete stage "${slug}" from disk?\n\nThis removes .sheets/stages/${slug}.coffee and drops the column from all activities.`)) return
    const r = await (await fetch('/api/stage/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    })).json()
    if (!r.ok) return this.showToast(r.error ?? 'stage delete failed')
    await this.loadMeta(false)
    this.showToast(`deleted stage ${slug}`)
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
  // Resolve the field path a column sorts/filters on. Field columns use their
  // path; stage columns use meta.writes[0]. User sort/filter always keys off
  // this path so stage.sort() is only a default when the user has not chosen.
  async valuePathForColumn(ci) {
    const col = this.columns[ci]
    if (!col) return null
    if (col.field) return col.field
    if (col.stage) {
      if (this._colValuePath[ci]) return this._colValuePath[ci]
      const path = await this.stageWritePath(col.stage)
      if (path) this._colValuePath[ci] = path
      return path
    }
    return null
  },
  onSearchInput(value) {
    this.searchDraft = value
    this.applySearchDraft(value, { immediate: false })
  },
  applySearchDraft(value, { immediate = false } = {}) {
    if (this._searchDebounce) {
      clearTimeout(this._searchDebounce)
      this._searchDebounce = null
    }
    const run = async () => {
      this._searchDebounce = null
      const text = String(value ?? '')
      if (text) {
        try { new RegExp(text) } catch {
          this.showToast('invalid regex')
          return
        }
      }
      if ((this.search || '') === text) return
      const id = 'sheets-search-input'
      const active = document.activeElement
      const keepFocus = active?.id === id
      const selStart = keepFocus ? active.selectionStart : null
      const selEnd = keepFocus ? active.selectionEnd : null
      this.search = text
      await this.refreshWindow(true)
      M.redraw()
      if (keepFocus) {
        const restore = () => {
          const input = document.getElementById(id)
          if (!input) return
          if (document.activeElement !== input) input.focus()
          try {
            if (selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd)
          } catch { /* ignore */ }
        }
        restore()
        requestAnimationFrame(restore)
      }
    }
    if (immediate) run()
    else this._searchDebounce = setTimeout(run, 500)
  },
  clearSearch() {
    if (this._searchDebounce) {
      clearTimeout(this._searchDebounce)
      this._searchDebounce = null
    }
    this.searchDraft = ''
    this.applySearchDraft('', { immediate: true })
    M.redraw()
    requestAnimationFrame(() => document.getElementById('sheets-search-input')?.focus())
  },
  async entityParams(offset, limit) {
    const params = new URLSearchParams({ activity: this.actSlug ?? '', offset: String(offset), limit: String(limit) })
    if (this.search) params.set('q', this.search)
    if (this.sort) {
      const path = await this.valuePathForColumn(this.sort.ci)
      if (path) {
        // Explicit user A–Z / Z–A — server must not fall back to stage.sort.
        params.set('sortPath', path)
        params.set('dir', this.sort.dir)
      } else {
        const col = this.columns[this.sort.ci]
        if (col?.stage) params.set('sortStage', col.stage)
        else if (col?.field) params.set('sortField', col.field)
        params.set('dir', this.sort.dir)
      }
    }
    // Per-column regex filters (AND). Empty / invalid patterns are skipped client-side.
    // A column can contribute two entries: the typed regex and the checked top values.
    const ciKeys = new Set([
      ...Object.keys(this.colFilters ?? {}),
      ...Object.keys(this.colFilterPicks ?? {}),
    ])
    for (const ciKey of ciKeys) {
      const ci = Number(ciKey)
      // Stage columns filter on views.text (what is rendered); field columns on the path.
      const stage = this.columns?.[ci]?.stage ?? ''
      const path = await this.valuePathForColumn(ci)
      if (!path && !stage) continue
      const not = this.colFilterNot?.[ci] ? '1' : '0'
      const push = (re) => {
        params.append('filterPath', path ?? '')
        params.append('filterRe', re)
        params.append('filterStage', stage)
        params.append('filterNot', not)
      }
      const text = String(this.colFilters?.[ci] ?? '')
      if (text) {
        try { new RegExp(text); push(text) } catch { /* invalid pattern */ }
      }
      const picks = this.colFilterPicks?.[ci] ?? []
      // Checked values are exact cell texts, so anchor them rather than substring-match.
      if (picks.length) push(`^(?:${picks.map(escapeRe).join('|')})$`)
    }
    return params
  },
  // ---- virtual scroll window (no multi-page cache) ----
  // GROK1: fixed ROWH when windowing, rAF scroll, rock-solid totalBodyH, translate3d.
  // Mutations call refreshWindow → reload:true so we always re-fetch (never serve stale rows).
  _windowCacheKey() {
    return JSON.stringify({
      a: this.actSlug ?? '',
      q: this.search ?? '',
      sort: this.sort ?? null,
      f: this.colFilters ?? {},
      n: this.colFilterNot ?? {},
      p: this.colFilterPicks ?? {},
    })
  },
  _invalidateWindowState() {
    this._windowKey = this._windowCacheKey()
    this._windowGen = (this._windowGen ?? 0) + 1
    this._totalKnown = false
    this._fullLoaded = false
    this._fetchInflight = null
  },
  // Small sheets can paint every row. Larger sheets retain a bounded native-height window.
  _canFullLoad() {
    return this._totalKnown && this.total >= 0 && this.total <= V_FULL_LOAD_MAX
  },
  // Direct range fetch — no page cache. Concurrent callers share one in-flight promise
  // only when the request range+key match; otherwise the newer gen wins.
  async _fetchEntities(offset, limit) {
    offset = Math.max(0, offset | 0)
    limit = Math.max(0, Math.min(V_FULL_LOAD_MAX, limit | 0))
    const keyAtStart = this._windowKey ?? this._windowCacheKey()
    const genAtStart = this._windowGen ?? 0
    try {
      const params = await this.entityParams(offset, limit)
      const data = await (await fetch(`/api/entities?${params}`)).json()
      if ((this._windowGen ?? 0) !== genAtStart || this._windowKey !== keyAtStart) {
        return null // stale after filter/activity change
      }
      const total = data.total ?? 0
      const rows = data.rows ?? []
      const off = data.offset ?? offset
      this.total = total
      this._totalKnown = true
      this.totalBodyH = Math.max(0, total * ROWH)
      return { offset: off, rows, total }
    } catch (err) {
      console.error('window fetch failed', err)
      return null
    }
  },
  // Fetch the entire filtered set, paging if a single response is truncated.
  async _fetchAllEntities() {
    const page = 500
    let offset = 0
    let total = null
    const rows = []
    while (total == null || offset < total) {
      const data = await this._fetchEntities(offset, page)
      if (!data) return null
      total = data.total ?? 0
      const batch = data.rows ?? []
      if (!batch.length) break
      for (const row of batch) rows.push(row)
      offset = rows.length
      if (batch.length < page) break
      if (rows.length >= total) break
    }
    return { offset: 0, rows, total: total ?? rows.length }
  },
  _visibleRange() {
    const el = document.querySelector('.gridwrap')
    const live = el?.scrollTop
    const scrollTop = (live != null && !this._programmaticGridScroll)
      ? live
      : (this._scrollTop ?? live ?? 0)
    if (live != null && !this._programmaticGridScroll) this._scrollTop = live
    const vh = el?.clientHeight ?? 600
    const viewportRows = Math.max(1, Math.ceil(vh / ROWH))
    let overTop = V_OVERSCAN
    let overBot = V_OVERSCAN
    const vel = this._scrollVel ?? 0
    if (vel > 1.2) overBot = V_OVERSCAN * 2
    else if (vel < -1.2) overTop = V_OVERSCAN * 2
    const visibleFirst = Math.max(0, Math.floor(scrollTop / ROWH))
    const visibleLast = visibleFirst + viewportRows
    const first = Math.max(0, visibleFirst - overTop)
    let count = viewportRows + overTop + overBot
    if (this._totalKnown) count = Math.min(count, Math.max(0, this.total - first))
    return { first, count, vel, scrollTop, visibleFirst, visibleLast, viewportRows }
  },
  // True when the currently painted window still covers the viewport + a safety margin.
  _windowCoversView(visibleFirst, visibleLast) {
    if (!this.rows?.length) return false
    const margin = Math.max(4, Math.min(12, V_OVERSCAN >> 2))
    const lo = this.winStart + margin
    const hi = this.winStart + this.rows.length - margin
    if (hi <= lo) return false
    return visibleFirst >= lo && visibleLast <= hi
  },
  _commitWindow(first, assembled, { force = false } = {}) {
    // force (reload/reset): always apply — row content may change with same ids/length.
    if (!force) {
      const same =
        first === this.winStart &&
        assembled.length === this.rows.length &&
        (assembled.length === 0 || (
          assembled[0]?.id === this.rows[0]?.id &&
          assembled[assembled.length - 1]?.id === this.rows[this.rows.length - 1]?.id
        ))
      if (same) return false
      // During an active fling, never rebuild the DOM — that kills momentum.
      if (this._isGridScrollHot()) {
        this._pendingWindow = true
        this._pendingFirst = first
        this._pendingAssembled = assembled
        this._scheduleScrollIdleFlush()
        return false
      }
    }
    this.winStart = first
    this.rows = assembled
    this.bodyOffsetY = first * ROWH
    if (!this.totalBodyH && this.total) this.totalBodyH = this.total * ROWH
    this._gridWindowCommit = true
    this._forceRedraw = true
    try { M.redraw() } finally {
      this._forceRedraw = false
      this._gridWindowCommit = false
    }
    this.scheduleStageMounts()
    return true
  },
  async ensureWindow({ reset = false, reload = false } = {}) {
    // Coalesce concurrent callers (scroll rAF + refreshWindow).
    if (this._ensureRunning) {
      this._ensureQueued = true
      if (reset) this._ensureReset = true
      if (reload) this._ensureReload = true
      return this._ensurePromise
    }
    this._ensureRunning = true
    this._ensurePromise = (async () => {
      try {
        let passes = 0
        do {
          if (++passes > 8) break
          this._ensureQueued = false
          this._scrollDirty = false
          const doReset = reset || this._ensureReset
          const doReload = reload || this._ensureReload || doReset
          this._ensureReset = false
          this._ensureReload = false
          reset = false
          reload = false

          const el = document.querySelector('.gridwrap')
          if (doReset) {
            this._invalidateWindowState()
            if (el) {
              this._programmaticGridScroll = true
              el.scrollTop = 0
              this._programmaticGridScroll = false
            }
            this._scrollTop = 0
            this._scrollVel = 0
            this._lastScrollTop = 0
          } else if (doReload) {
            // Keep scroll and keep _fullLoaded so rowHeightMode stays rows-natural
            // during the await — flipping to rows-fixed mid-reload collapses tall
            // rows (row 2 "teleports" up, then down when heights restore).
            this._windowGen = (this._windowGen ?? 0) + 1
          }
          const key = this._windowCacheKey()
          if (key !== this._windowKey) this._invalidateWindowState()

          // Bootstrap total if unknown.
          if (!this._totalKnown) {
            const boot = await this._fetchEntities(0, 1)
            if (!boot) break
          }

          // Stable pagination replaces virtual-window scrolling for the grid.
          if (this.usePagination) {
            if (doReset) this.page = 0
            const maxPage = Math.max(0, Math.ceil((this.total || 0) / this.pageSize) - 1)
            this.page = Math.max(0, Math.min(this.page, maxPage))
            this.savePaginationPrefs()
            const first = this.page * this.pageSize
            const data = await this._fetchEntities(first, this.pageSize)
            if (!data) break
            this._fullLoaded = false
            this._commitWindow(first, data.rows, { force: true })
            break
          }

          // ---- Full-load path (small sheets): paint everything; native scroll ----
          if (this._canFullLoad() || (doReload && this._fullLoaded)) {
            if (!this._fullLoaded || doReload) {
              const data = await this._fetchEntities(0, Math.max(this.total || 1, 1))
              if (!data) break
              if (data.total > V_FULL_LOAD_MAX) {
                this._fullLoaded = false
                this._ensureQueued = true
                continue
              }
              this._fullLoaded = true
              this._commitWindow(0, data.rows, { force: true })
            }
            break
          }
          this._fullLoaded = false

          // ---- Windowed path: rows keep natural height; ROWH estimates spacers ----
          let { first, count, visibleFirst, visibleLast } = this._visibleRange()
          if (!doReload && this._isGridScrollHot() && this._windowCoversView(visibleFirst, visibleLast)) break
          if (!doReload && this._totalKnown && this._windowCoversView(visibleFirst, visibleLast)) break

          count = Math.min(count, V_FULL_LOAD_MAX)
          const data = await this._fetchEntities(first, Math.max(count, 1))
          if (!data) break

          ;({ first, count } = this._visibleRange())
          if (this._totalKnown) count = Math.min(count, Math.max(0, this.total - first), V_FULL_LOAD_MAX)
          let assembled = data.offset === first ? data.rows : null
          if (!assembled) {
            const again = await this._fetchEntities(first, Math.max(count, 1))
            if (!again) break
            assembled = again.rows
          }
          this._commitWindow(first, assembled.slice(0, count), { force: doReload || doReset })
        } while (this._ensureQueued || this._scrollDirty)
      } finally {
        this._ensureRunning = false
        this._ensurePromise = null
      }
    })()
    return this._ensurePromise
  },
  // Public API: reset=true → scroll to top + reload; false → reload in place (mutations).
  async refreshWindow(reset) {
    if (reset) await this.ensureWindow({ reset: true })
    else await this.ensureWindow({ reload: true })
  },
  resetGridScrollTop() {
    const el = document.querySelector('.gridwrap')
    if (el) {
      this._programmaticGridScroll = true
      try { el.scrollTop = 0 } finally { this._programmaticGridScroll = false }
    }
    this._scrollTop = 0
    this._scrollVel = 0
    this._lastScrollTop = 0
  },
  setPage(nextPage) {
    const page = Math.max(0, Math.min(Number(nextPage) || 0, this.pageCount - 1))
    if (page === this.page) return
    this.page = page
    this.savePaginationPrefs()
    this.resetGridScrollTop()
    this.refreshWindow(false)
  },
  jumpToPage(value) {
    const pageNumber = Math.round(Number(value))
    if (!Number.isFinite(pageNumber)) return
    this.setPage(pageNumber - 1)
  },
  setPageSize(value) {
    const next = Math.max(1, Math.min(100, Number(value) || 10))
    if (next === this.pageSize) return
    this.pageSize = next
    this.page = 0
    this.savePaginationPrefs()
    this.resetGridScrollTop()
    this.refreshWindow(false)
  },
  onScroll(e) {
    // Ignore only our own programmatic restores (setting scrollTop after M.redraw).
    if (this._programmaticGridScroll) return
    const el = e?.target ?? document.querySelector('.gridwrap')
    if (!el) return
    const now = performance.now()
    const top = el.scrollTop
    if (this._lastScrollT != null) {
      const dt = Math.max(1, now - this._lastScrollT)
      this._scrollVel = (top - (this._lastScrollTop ?? top)) / dt // px/ms
    }
    this._lastScrollTop = top
    this._lastScrollT = now
    this._scrollTop = top
    this._scrollLeft = el.scrollLeft
    this._gridUserScrollAt = now
    this._scheduleScrollIdleFlush()

    // Pagination still needs this snapshot for redraw restoration; it simply
    // does not need virtual-window fetching below.
    if (this.usePagination) return

    // Full-load sheets: native scroll only — never ensureWindow/redraw on scroll.
    if (this._fullLoaded && this._canFullLoad()) return

    if (this._preservingScroll) {
      this._scrollDirty = true
      return
    }
    this._scrollDirty = true
    if (!this._scrollRaf) {
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0
        if (!this._scrollDirty) return
        this.ensureWindow({ reset: false })
      })
    }
  },
  // Spacers: total height = totalBodyH stays fixed while top/bot pads rebalance.
  // Full-load natural rows: winStart=0 and rows.length===total → pads are 0; native height wins.
  get topPad() { return this.usePagination ? 0 : this.winStart * ROWH },
  get bottomPad() {
    if (this.usePagination) return 0
    const totalH = this.totalBodyH || ((this.total || 0) * ROWH)
    return Math.max(0, totalH - this.topPad - this.rows.length * ROWH)
  },
  get bodyTransform() {
    // GPU layer promotion (GROK1 #3). Geometry comes from top/bot spacers, not translate Y.
    return 'translate3d(0,0,0)'
  },
  // Natural variable height is never contingent on total entity count.
  get rowHeightMode() {
    return 'rows-natural'
  },

  // ---- cell rendering (Γ, §4.1 default widgets) ----
  // Stage views.js load/reload. Multiple signals (tool_result, stages_updated, WS)
  // are debounced into at most one network fetch; we keep the previous module
  // painted until a *different* source hash is ready (no empty flash, no redraw storm).
  async _fetchStageViewsCode(slug) {
    const url = `/api/stage/${encodeURIComponent(slug)}/views.js?t=${Date.now()}`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`views ${res.status}`)
    return res.text()
  },
  async _importStageViews(slug, hash) {
    // Real URL import: the browser resolves the module's own `../lib/*.mjs`
    // relatives against /stagemod/stages/. The stage endpoint stamps its lib
    // imports with mtimes, so use a fresh stage URL to pick up changed libs too.
    const url = `/stagemod/stages/${encodeURIComponent(slug)}.mjs?v=${hash}&load=${Date.now()}`
    return await import(/* webpackIgnore: true */ url)
  },
  _hashStr(s) {
    // Cheap non-crypto hash for "did views.js change?"
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  },
  ensureView(slug, { force = false } = {}) {
    if (!slug) return Promise.resolve(null)
    if (!this._viewPromises) this._viewPromises = {}
    if (!this._viewGen) this._viewGen = {}
    if (!this._viewSourceHash) this._viewSourceHash = {}
    // Cache hit (unless force).
    if (!force && this.viewMods[slug] !== undefined) return Promise.resolve(this.viewMods[slug])
    // Share in-flight load (including force — don't stack parallel force fetches).
    if (this.viewLoading[slug] && this._viewPromises[slug]) return this._viewPromises[slug]
    const gen = (this._viewGen[slug] ?? 0) + 1
    this._viewGen[slug] = gen
    this.viewLoading[slug] = true
    const hadPrevious = this.viewMods[slug] != null
    const prevHash = this._viewSourceHash[slug]
    const p = this._fetchStageViewsCode(slug)
      .then(async (code) => {
        if (this._viewGen[slug] !== gen) return this.viewMods[slug] ?? null
        const hash = this._hashStr(code)
        // A forced reload may be caused by a changed browser-safe lib. The
        // stage Coffee source hash can be identical in that case, so re-import.
        const m = await this._importStageViews(slug, hash)
        if (this._viewGen[slug] !== gen) return this.viewMods[slug] ?? null
        this.viewMods[slug] = m
        this._viewSourceHash[slug] = hash
        return { mod: m, changed: force || !hadPrevious || prevHash !== hash }
      })
      .then((result) => {
        if (this._viewGen[slug] !== gen) return this.viewMods[slug] ?? null
        if (result && typeof result === 'object' && 'mod' in result) {
          if (result.changed) this.scheduleViewRedraw()
          return result.mod
        }
        // Unchanged force-reload path returned the old module directly.
        return result
      })
      .catch((err) => {
        console.warn('ensureView failed', slug, err)
        if (this._viewGen[slug] !== gen) return this.viewMods[slug] ?? null
        if (!hadPrevious) this.viewMods[slug] = null
        return this.viewMods[slug] ?? null
      })
      .finally(() => {
        if (this._viewGen[slug] === gen) {
          this.viewLoading[slug] = false
          delete this._viewPromises[slug]
        }
      })
    this._viewPromises[slug] = p
    return p
  },
  scheduleViewRedraw() {
    if (this._viewRedrawPending) return
    this._viewRedrawPending = true
    requestAnimationFrame(() => {
      this._viewRedrawPending = false
      const force = this._forceNextViewRedraw === true
      this._forceNextViewRedraw = false
      if (force) {
        M.redraw({ force: true })
        this.scheduleStageMounts()
      } else {
        this.redrawGrid()
      }
    })
  },
  // Coalesce bursty signals (tool_result + stages_updated + WS) into one trailing reload.
  // No long cooldown — content-hash still skips redraw when source is unchanged.
  scheduleStageViewReload(slug, { delay = 80 } = {}) {
    if (!slug) return
    if (!this._stageReloadTimers) this._stageReloadTimers = {}
    clearTimeout(this._stageReloadTimers[slug])
    this._stageReloadTimers[slug] = setTimeout(() => {
      delete this._stageReloadTimers[slug]
      this.reloadStageView(slug)
    }, delay)
  },
  async reloadStageView(slug) {
    if (!slug) return
    // In-flight ensureView is shared; force reuses the same promise if loading.
    await this.ensureView(slug, { force: true })
  },
  cellHtml(row, ci) {
    const col = this.columns[ci]
    if (!col) return ''
    if (col.stage) {
      this.ensureView(col.stage)
      const mod = this.viewMods[col.stage]
      if (mod?.views?.cell) {
        try { return mod.views.cell(row.doc, { entityId: row.id })?.template ?? '' } catch (e) { return `<span class="cellstate">⚠ ${esc(e.message)}</span>` }
      }
      const writes = mod?.meta?.writes?.[0]
      return writes ? this.widget(getPath(row.doc, writes), `${row.id}|${ci}`) : ''
    }
    if (col.field) return this.widget(getPath(row.doc, col.field), `${row.id}|${ci}`)
    return ''
  },
  stageCellKey(rowId, stage) { return `${rowId}|${stage}` },
  scheduleStageMounts({ retry = true } = {}) {
    if (this._stageMountRaf) return
    this._stageMountRaf = requestAnimationFrame(() => {
      this._stageMountRaf = 0
      this.syncStageMounts()
      // A throttled root redraw can leave this pass ahead of fresh cell DOM.
      // Retry once after the MJS throttle window so interactive views mount.
      if (retry && !this._stageMountRetryTimer) {
        this._stageMountRetryTimer = setTimeout(() => {
          this._stageMountRetryTimer = null
          this.scheduleStageMounts({ retry: false })
        }, 550)
      }
    })
  },
  /** After paint: call optional views.mount(el, ctx) on stage cells; unmount stale ones. */
  syncStageMounts() {
    if (!this._stageMounts) this._stageMounts = new Map()
    const seen = new Set()
    const viewport = document.querySelector('.gridwrap')?.getBoundingClientRect()
    const top = (viewport?.top ?? 0) - 320
    const bottom = (viewport?.bottom ?? window.innerHeight) + 320
    const tds = document.querySelectorAll('td[data-r][data-c] .cell-inner')
    for (const inner of tds) {
      const rect = inner.getBoundingClientRect()
      if (rect.bottom < top || rect.top > bottom) continue
      const td = inner.closest('td[data-r][data-c]')
      if (!td) continue
      const i = Number(td.dataset.r)
      const ci = Number(td.dataset.c)
      if (!Number.isFinite(i) || !Number.isFinite(ci)) continue
      const row = this.rows[i]
      const col = this.columns[ci]
      if (!row?.id || !col?.stage) continue
      const slug = col.stage
      const mod = this.viewMods[slug]
      if (!mod?.views?.mount) continue
      const key = this.stageCellKey(row.id, slug)
      seen.add(key)
      const prev = this._stageMounts.get(key)
      // Remount when DOM node was replaced (x-html rewrite) or entity id changed.
      if (prev && prev.el === inner && prev.slug === slug && prev.id === row.id) continue
      if (prev?.unmount) {
        try { prev.unmount() } catch {}
      }
      let unmount = null
      try {
        const ctx = this.makeStageViewCtx(row, ci, slug)
        const ret = mod.views.mount(inner, ctx)
        if (typeof ret === 'function') unmount = ret
        else if (ret && typeof ret.unmount === 'function') unmount = () => ret.unmount()
      } catch (err) {
        console.warn('views.mount failed', slug, err)
      }
      this._stageMounts.set(key, { el: inner, slug, id: row.id, unmount })
    }
    for (const [key, prev] of [...this._stageMounts.entries()]) {
      if (seen.has(key)) continue
      if (prev?.unmount) {
        try { prev.unmount() } catch {}
      }
      this._stageMounts.delete(key)
    }
  },
  makeStageViewCtx(row, ci, stage) {
    const app = this
    const entityId = row.id
    const local = Math.max(0, app.rows.indexOf(row))
    const absR = app.winStart + local
    const liveEntity = () => app.rows.find((r) => r.id === entityId)?.doc ?? row.doc
    return {
      get entity() { return liveEntity() },
      entityId,
      stage,
      activity: app.actSlug,
      columnIndex: ci,
      rowIndex: absR,
      canPersist: () => app.canPersist(),
      patchEntity: (patch) => app.patchEntity(entityId, patch),
      rpc: (method, args = null) => app.callStageRpc(entityId, stage, method, args),
      openEditor: (editor) => {
        app.stageEditing = { stage, id: entityId, r: absR, ci }
        app.openStageEditor({ ...editor, entityId, columnIndex: ci })
      },
      closeEditor: () => {
        if (app.stageEditing?.id === entityId && app.stageEditing?.stage === stage) app.stageEditing = null
        app.closeStageEditor()
      },
      setStageEditing: (on, draft = null) => {
        if (on) {
          app.stageEditing = {
            stage, id: entityId, r: absR, ci,
            draft: draft ?? (app.stageEditing?.id === entityId && app.stageEditing?.stage === stage ? app.stageEditing.draft : ''),
          }
        } else if (app.stageEditing?.id === entityId && app.stageEditing?.stage === stage) {
          app.stageEditing = null
        }
        // Do not full-redraw while focusing an input — just track state.
      },
      isStageEditing: () => app.stageEditing?.id === entityId && app.stageEditing?.stage === stage,
      getStageEditDraft: () => app.stageEditing?.id === entityId && app.stageEditing?.stage === stage ? app.stageEditing.draft : null,
      showToast: (msg) => app.showToast(msg),
      redraw: () => { M.redraw(); app.scheduleStageMounts() },
    }
  },
  openStageEditor(editor) {
    if (!editor?.key || !editor?.component) return
    this.stageEditor = editor
    M.redraw({ force: true })
  },
  isStageEditorCell(row, ci) {
    return this.stageEditor?.entityId === row?.id && this.stageEditor?.columnIndex === ci
  },
  closeStageEditor() {
    const key = this.stageEditor?.key
    this.stageEditor = null
    if (key) M.unmountComponent?.(key)
    M.redraw({ force: true })
  },
  /** Generic entity patch: { component: { fieldOrNestedPath: value } } via PATCH API. */
  async patchEntity(id, patch) {
    if (!this.canPersist()) {
      this.showToast('desynced — cannot persist')
      return null
    }
    if (!id || !patch || typeof patch !== 'object') return null
    try {
      const response = await fetch(`/api/entity/${encodeURIComponent(id)}?activity=${this.actSlug}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ patch }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error ?? `save failed (${response.status})`)
      const doc = result.doc
      if (doc) {
        this.rows = this.rows.map((row) => row.id === id ? { ...row, doc } : row)
        M.redraw()
        this.scheduleStageMounts()
      }
      return doc
    } catch (error) {
      this.showToast(error.message ?? 'save failed')
      return null
    }
  },
  async callStageRpc(id, stage, method, args = null) {
    if (!this.canPersist()) {
      this.showToast('desynced — cannot run RPC')
      return null
    }
    try {
      const response = await fetch('/api/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activity: this.actSlug, id, stage, method, args }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error ?? `RPC failed (${response.status})`)
      if (result.doc) {
        this.rows = this.rows.map((row) => row.id === id ? { ...row, doc: result.doc } : row)
        this.redrawGrid()
      }
      this.showToast(result.message ?? `${stage}: ${method} complete`)
      return result
    } catch (error) {
      this.showToast(error.message ?? 'RPC failed')
      return null
    }
  },
  /** Dispatch keyboard to the active stage view when it implements views.onKey. */
  dispatchStageKey(e) {
    const a = this.sel.active
    if (!a) return false
    const col = this.columns[a.c]
    if (!col?.stage) return false
    const mod = this.viewMods[col.stage]
    if (typeof mod?.views?.onKey !== 'function') return false
    const i = a.r - this.winStart
    const row = this.rows[i]
    if (!row) return false
    const ctx = this.makeStageViewCtx(row, a.c, col.stage)
    try {
      return mod.views.onKey(e, ctx) === true
    } catch (err) {
      console.warn('views.onKey failed', col.stage, err)
      return false
    }
  },
  jsonBranchKey(cellKey, path) { return `${cellKey}|${path}` },
  jsonValueHtml(v, cellKey, path = '$') {
    if (v === null) return '<span class="json-null">null</span>'
    if (typeof v === 'boolean') return `<span class="json-bool">${v}</span>`
    if (typeof v === 'number') return `<span class="json-number">${esc(v)}</span>`
    if (typeof v === 'string') return `<span class="json-string">&quot;${esc(v)}&quot;</span>`
    if (!v || typeof v !== 'object') return `<span>${esc(v)}</span>`

    const array = Array.isArray(v)
    const entries = array ? v.map((value, index) => [String(index), value]) : Object.entries(v)
    const key = this.jsonBranchKey(cellKey, path)
    const expanded = this.jsonExpanded[key] === true
    const open = array ? '[' : '{'
    const close = array ? ']' : '}'
    if (!expanded) {
      return `<span class="json-node json-collapsed">${open}<button type="button" class="json-toggle" data-json-key="${encodeURIComponent(key)}" title="expand ${array ? 'array' : 'object'}"><span class="json-count">${entries.length}</span><i class="ph-bold ph-plus" aria-hidden="true"></i></button>${close}</span>`
    }
    const children = entries.map(([name, value]) => {
      const childPath = `${path}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`
      const label = array ? '' : `<span class="json-key">&quot;${esc(name)}&quot;</span><span class="json-punct">: </span>`
      return `<span class="json-line">${label}${this.jsonValueHtml(value, cellKey, childPath)}</span>`
    }).join('<span class="json-punct">,</span>')
    return `<span class="json-node json-expanded">${open}<button type="button" class="json-toggle" data-json-key="${encodeURIComponent(key)}" title="collapse ${array ? 'array' : 'object'}"><i class="ph-bold ph-minus" aria-hidden="true"></i></button>${children ? `<span class="json-children">${children}</span>` : ''}${close}</span>`
  },
  widget(v, cellKey = '') {
    if (v === undefined) return '<span style="color:var(--dim)">—</span>'
    if (v === null) return '<span style="color:var(--dim)">—</span>'
    if (typeof v === 'boolean') return `<input type="checkbox" disabled ${v ? 'checked' : ''}>`
    if (typeof v === 'number') return `<span style="float:right;font-family:ui-monospace,monospace">${esc(v)}</span>`
    if (Array.isArray(v) || typeof v === 'object') return `<span class="cell-tall json-tree">${this.jsonValueHtml(v, cellKey)}</span>`
    const s = String(v)
    if (/^#[0-9a-f]{6}$/i.test(s)) return `<span class="cell-swatch"><span class="swatch" style="background:${esc(s)}"></span>${esc(s)}</span>`
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) return `<span title="${esc(s)}">${esc(new Date(s).toLocaleDateString())}</span>`
    if (/^https?:\/\//.test(s)) return `<a href="${esc(s)}" target="_blank">${esc(s)}</a>`
    if (s.includes('\n')) return `${esc(s.split('\n')[0])} <span style="color:var(--dim)">¶${s.split('\n').length}</span>`
    return `<span title="${esc(s)}">${esc(s)}</span>`
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
    const toggle = e.target.closest?.('.json-toggle')
    if (toggle) {
      e.preventDefault()
      e.stopPropagation()
      const key = decodeURIComponent(toggle.dataset.jsonKey ?? '')
      if (key) {
        this.jsonExpanded = { ...this.jsonExpanded, [key]: !this.jsonExpanded[key] }
        this.redrawGrid()
        requestAnimationFrame(() => {
          const row = this.rows[i]
          const cell = document.querySelector(`td[data-r="${i}"][data-c="${ci}"]`)
          const content = cell?.querySelector('.json-tree')
          if (!row?.id || !cell || !content) return
          const expanded = content.querySelector('.json-expanded')
          const nextHeights = { ...this.rowHeights }
          if (expanded) nextHeights[row.id] = Math.max(ROWH, Math.ceil(content.scrollHeight) + 8)
          else delete nextHeights[row.id]
          this.rowHeights = nextHeights
          this.redrawGrid()
        })
      }
      return
    }
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
  clearSelection() {
    if (!this.sel.ranges.length && !this.sel.active) return
    this.sel = { ranges: [], active: null, anchor: null }
    M.redraw()
  },
  // Mousedown on the empty area beside/below the grid deselects, like Escape.
  // Anything that owns its own click (cells, headers, menus, resize grips) opts out.
  gridVoidDown(e) {
    if (e.target.closest('td, th, .col-filter-menu, .col-resize, .row-resize')) return
    this.clearSelection()
  },
  colHeadClick(ci, e) {
    if (this.colResize?.moved || this._suppressColClick) return
    if (e.altKey) return this.toggleSort(ci)
    const range = { r0: 0, c0: ci, r1: Math.max(0, this.total - 1), c1: ci }
    if (e.ctrlKey || e.metaKey) this.sel.ranges.push(range)
    else this.sel.ranges = [range]
    this.sel.anchor = { r: 0, c: ci }
    this.sel.active = { r: 0, c: ci }
  },
  colWidth(ci) {
    if (this.colResize?.ci === ci) return this.colResize.width
    const width = this.columns[ci]?.width
    return width == null || width === '' ? DEFAULT_COL_WIDTH : normalizeColWidth(width)
  },
  colStyle(ci) {
    const width = this.colWidth(ci)
    return `width:${width}px;min-width:${width}px;max-width:${width}px`
  },
  startColResize(ci, e) {
    if (e.button != null && e.button !== 0) return
    if (!this.columns[ci]) return
    e.preventDefault()
    e.stopPropagation()
    const startW = this.colWidth(ci)
    const startX = e.clientX
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    this.colResize = { ci, width: startW, startX, startW, moved: false }
    this.resizing = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.querySelector('table.grid')?.classList.add('col-resizing')
    const move = (event) => {
      if (!this.colResize || this.colResize.ci !== ci) return
      const next = normalizeColWidth(startW + event.clientX - startX)
      if (Math.abs(event.clientX - startX) > 2) this.colResize.moved = true
      if (next === this.colResize.width) return
      this.colResize.width = next
      M.redraw()
    }
    const up = async () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      document.querySelector('table.grid')?.classList.remove('col-resizing')
      const draft = this.colResize
      this.colResize = null
      this.resizing = false
      if (draft?.moved) {
        this._suppressColClick = true
        setTimeout(() => { this._suppressColClick = false }, 0)
      }
      M.redraw()
      if (!draft?.moved) return
      const width = normalizeColWidth(draft.width)
      const prevWidth = this.columns[ci]?.width
      if (prevWidth != null && width === normalizeColWidth(prevWidth)) return
      if (!this.canPersist()) return this.showToast('refresh to sync before resizing columns')
      const columns = copyColumns(this.fullColumns)
      const fi = this.fullIndexFromVisible(ci)
      if (fi < 0) return
      columns[fi] = { ...columns[fi], width }
      try {
        await this.patchColumns(columns)
      } catch (error) {
        this.showToast(error.message ?? 'could not save column width')
        M.redraw()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  },
  // User-resized height only; null means "natural / content-driven".
  rowHeightPx(row) {
    if (!row?.id) return null
    const h = this.rowHeights[row.id]
    return h == null ? null : normalizeRowHeight(h)
  },
  isRowCollapsed(row) { return !!row?.id && this.collapsedRowIds[row.id] === true },
  toggleRowCollapsed(row) {
    if (!row?.id) return
    const next = { ...this.collapsedRowIds }
    if (next[row.id]) delete next[row.id]
    else next[row.id] = true
    this.collapsedRowIds = next
    this.saveCollapsedRows()
    this.redrawGrid()
  },
  rowStyle(row) {
    if (this.isRowCollapsed(row)) return `--row-h:${ROWH}px;height:${ROWH}px`
    const h = this.rowHeightPx(row)
    if (h != null) return `--row-h:${h}px;height:${h}px`
    // Virtual window needs a fixed height so spacers stay accurate.
    if (this.rowHeightMode === 'rows-fixed') return `--row-h:${ROWH}px;height:${ROWH}px`
    return ''
  },
  rowClass(row) {
    if (this.isRowCollapsed(row)) return 'row-h-fixed row-collapsed'
    if (this.rowHeightPx(row) != null) return 'row-h-fixed'
    if (this.rowHeightMode === 'rows-fixed') return 'row-h-fixed'
    return ''
  },
  // Sticky thead = column letters + magic filter row.
  gridHeaderH() {
    const thead = document.querySelector('.gridwrap thead')
    if (thead) {
      const h = thead.getBoundingClientRect().height
      if (h > 0) return h
    }
    return ROWH + 30 // --rowh + --magich fallback
  },
  pageRowCount() {
    const el = document.querySelector('.gridwrap')
    const bodyH = Math.max(ROWH, (el?.clientHeight ?? 600) - this.gridHeaderH())
    return Math.max(1, Math.floor(bodyH / ROWH))
  },
  startRowResize(i, e) {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const row = this.rows[i]
    if (!row?.id) return
    const tr = e.currentTarget?.closest?.('tr') ?? document.querySelector(`tr[data-row-id="${CSS.escape(row.id)}"]`)
    // Prefer live measured height (natural tall rows, or current fixed height).
    const startH = Math.round(tr?.getBoundingClientRect().height || this.rowHeightPx(row) || ROWH)
    const startY = e.clientY
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    this.rowResize = { id: row.id, startY, startH, moved: false }
    this._suppressRowClick = false
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.querySelector('table.grid')?.classList.add('row-resizing')
    const move = (event) => {
      if (!this.rowResize || this.rowResize.id !== row.id) return
      const next = normalizeRowHeight(startH + (event.clientY - startY))
      if (Math.abs(event.clientY - startY) > 2) this.rowResize.moved = true
      this.rowHeights = { ...this.rowHeights, [row.id]: next }
      M.redraw()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      document.querySelector('table.grid')?.classList.remove('row-resizing')
      if (this.rowResize?.moved) this._suppressRowClick = true
      this.rowResize = null
      M.redraw()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  },
  rowHeadClick(i, e) {
    if (this._suppressRowClick) {
      this._suppressRowClick = false
      return
    }
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
    // Ctrl/Cmd+G always runs the selected cells, even when a stage editor is
    // open or another editor has focus; it must not be swallowed by any guard.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      void this.play()
      return
    }
    // The root-owned stage editor is authoritative: its first Escape closes
    // edit mode, and only a subsequent Escape may clear the sheet selection.
    if (e.key === 'Escape' && this.stageEditor) {
      e.preventDefault()
      e.stopImmediatePropagation()
      this.closeStageEditor()
      return
    }
    if (this.editing || this.focus) return
    // Stage-owned inputs keep focus; Escape still cancels stage edit via onKey when possible.
    const tag = e.target?.tagName
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable
    if (inField && !e.target?.closest?.('.stage-view-root')) return
    if (this.stageEditing || this.dispatchStageKey(e)) {
      // Stage view handled the key (or is mid-edit). Escape without handler cancels stageEditing.
      if (e.key === 'Escape' && this.stageEditing && !inField) {
        e.preventDefault()
        this.stageEditing = null
        M.redraw()
        this.scheduleStageMounts()
      }
      return
    }
    if (inField) return
    if (e.key === 'Escape') {
      e.preventDefault()
      this.clearSelection()
      return
    }
    const a = this.sel.active
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      const row = a ? this.rows[a.r - this.winStart] : null
      if (!row) return
      e.preventDefault()
      this.toggleRowCollapsed(row)
      return
    }
    const lastR = Math.max(0, (this.total || 1) - 1)
    const lastC = Math.max(0, this.columns.length - 1)
    const moveSelTo = (r, c, { shift } = {}) => {
      r = Math.max(0, Math.min(lastR, r))
      c = Math.max(0, Math.min(lastC, c))
      if (shift && this.sel.anchor) {
        const an = this.sel.anchor
        this.sel.ranges[Math.max(0, this.sel.ranges.length - 1)] =
          { r0: Math.min(an.r, r), c0: Math.min(an.c, c), r1: Math.max(an.r, r), c1: Math.max(an.c, c) }
      } else {
        this.sel.ranges = [{ r0: r, c0: c, r1: r, c1: c }]
        this.sel.anchor = { r, c }
      }
      this.sel.active = { r, c }
      return r
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      this.copySelection()
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Stage columns: never blank via generic path unless the view handled it above.
      const col = a ? this.columns[a.c] : null
      if (col?.stage) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      this.blankSelection()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault()
      this.sel.ranges = [{ r0: 0, c0: 0, r1: lastR, c1: lastC }]
      return
    }
    // Ctrl/Cmd+Home → first row; Ctrl/Cmd+End → last row (scroll + selection).
    if ((e.ctrlKey || e.metaKey) && e.key === 'Home') {
      e.preventDefault()
      const c = a?.c ?? 0
      if (a || this.sel.ranges.length) moveSelTo(0, c, { shift: e.shiftKey })
      this.scrollToRow(0, { align: 'start' })
      M.redraw()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'End') {
      e.preventDefault()
      const c = a?.c ?? 0
      if (a || this.sel.ranges.length) moveSelTo(lastR, c, { shift: e.shiftKey })
      this.scrollToRow(lastR, { align: 'end' })
      M.redraw()
      return
    }
    // PageUp / PageDown: move by a viewport of body rows (and scroll).
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      const dir = e.key === 'PageDown' ? 1 : -1
      const page = this.pageRowCount()
      if (a) {
        const r = moveSelTo(a.r + dir * page, a.c, { shift: e.shiftKey })
        this.scrollToRow(r, { align: dir > 0 ? 'end' : 'start' })
        M.redraw()
      } else {
        const el = document.querySelector('.gridwrap')
        if (el) {
          el.scrollTop = Math.max(0, el.scrollTop + dir * page * ROWH)
          this._scrollTop = el.scrollTop
          this.onScroll({ target: el })
        }
      }
      return
    }
    if (!a) return
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
    if (move) {
      e.preventDefault()
      let [dr, dc] = move
      if (e.ctrlKey || e.metaKey) { dr *= this.total; dc *= this.columns.length } // jump to edge
      const r = moveSelTo(a.r + dr, a.c + dc, { shift: e.shiftKey })
      this.scrollToRow(r)
      return
    }
    // Field columns use the overlay editor; stage columns only edit if the view handles keys.
    const activeCol = this.columns[a.c]
    if (activeCol?.stage) {
      if (e.key === 'Enter' || (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1)) {
        e.preventDefault()
        // onKey already had a chance above; no generic stage overlay.
      }
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); this.startEditActive() }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      e.preventDefault()
      this.startEditActive(e.key)
    }
  },
  // align: 'start' | 'end' | 'nearest' (default).
  // Prefer measuring the painted <tr> (correct for variable heights); fall back to ROWH math.
  scrollToRow(r, { align = 'nearest' } = {}) {
    const el = document.querySelector('.gridwrap')
    if (!el) return
    const lastR = Math.max(0, (this.total || 1) - 1)
    r = Math.max(0, Math.min(lastR, r))
    const headerH = this.gridHeaderH()
    const local = r - this.winStart
    const tr = (local >= 0 && local < this.rows.length)
      ? el.querySelector(`tr.virtual-row[data-row-id="${CSS.escape(this.rows[local]?.id ?? '')}"]`)
        || el.querySelectorAll('tr.virtual-row')[local]
      : null

    let yStart
    let yEnd
    if (tr) {
      // Position of row relative to scroll content: current scrollTop + offset from viewport top - header.
      const gRect = el.getBoundingClientRect()
      const tRect = tr.getBoundingClientRect()
      const rowTopInContent = el.scrollTop + (tRect.top - gRect.top) - headerH
      const rowH = tRect.height
      yStart = Math.max(0, rowTopInContent)
      yEnd = Math.max(0, el.scrollTop + (tRect.bottom - gRect.top) - el.clientHeight)
      // Simpler: bring row under sticky header / into view using element offset within table body.
      // rowTopInContent above already accounts for current layout (variable heights).
      if (align === 'end') {
        yEnd = Math.max(0, yStart + rowH + headerH - el.clientHeight)
      }
    } else {
      yStart = r * ROWH
      yEnd = Math.max(0, headerH + (r + 1) * ROWH - el.clientHeight)
    }

    if (align === 'start') el.scrollTop = yStart
    else if (align === 'end') el.scrollTop = yEnd
    else {
      const viewTop = el.scrollTop
      const viewBot = el.scrollTop + el.clientHeight
      if (tr) {
        const gRect = el.getBoundingClientRect()
        const tRect = tr.getBoundingClientRect()
        // Fully above sticky header area, or clipped below viewport.
        if (tRect.top < gRect.top + headerH) el.scrollTop = yStart
        else if (tRect.bottom > gRect.bottom) el.scrollTop = yEnd
      } else {
        const rowDocBot = headerH + (r + 1) * ROWH
        if (yStart < viewTop) el.scrollTop = yStart
        else if (rowDocBot > viewBot) el.scrollTop = yEnd
      }
    }
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
    if (el.scrollTop > maxTop) el.scrollTop = maxTop
    this._scrollTop = el.scrollTop
    this._scrollDirty = true
    this.onScroll({ target: el })
    this.ensureWindow({ reset: false })
  },
  get selReadout() {
    if (!this.sel.ranges.length) return ''
    return this.sel.ranges.map((g) => {
      const whole = g.r0 === 0 && g.r1 >= this.total - 1
      const a = `${colLetter(g.c0)}${whole ? '' : g.r0 + 1}`
      const b = `${colLetter(g.c1)}${whole ? '' : g.r1 + 1}`
      return a === b ? a : `${a}:${b}`
    }).join(',')
  },
  // Selection impact for play: unique entities, unique stages, enqueueable jobs.
  selectionPlayStats() {
    if (!this.sel?.ranges?.length) return null
    const entities = new Set()
    const stages = new Set()
    const jobs = new Set()
    for (const g of this.sel.ranges) {
      for (let r = Math.max(0, g.r0); r <= Math.min(this.total - 1, g.r1); r++) {
        entities.add(r)
        for (let c = Math.max(0, g.c0); c <= Math.min(this.columns.length - 1, g.c1); c++) {
          const stage = this.columns[c]?.stage
          if (!stage) continue
          stages.add(stage)
          jobs.add(`${r}|${stage}`)
        }
      }
    }
    return { entities: entities.size, stages: stages.size, jobs: jobs.size }
  },
  get playSummaryLabel() {
    const stats = this.selectionPlayStats()
    if (!stats) {
      const n = this.total ?? 0
      return `${n} entit${n === 1 ? 'y' : 'ies'}`
    }
    const e = `${stats.entities} entit${stats.entities === 1 ? 'y' : 'ies'}`
    const s = `${stats.stages} stage${stats.stages === 1 ? '' : 's'}`
    const j = `${stats.jobs} job${stats.jobs === 1 ? '' : 's'}`
    return `${e}, ${s} = ${j}`
  },
  async copySelReadout() {
    const text = this.selReadout
    if (!text) return this.showToast('nothing selected')
    try {
      await navigator.clipboard.writeText(text)
      this.showToast(`copied ${text}`)
    } catch {
      this.showToast('clipboard copy failed')
    }
  },
  async copyEntityPath(row) {
    const text = row?.file || (this.act?.source && row?.id ? `${this.act.source}/${row.id}.yaml` : row?.id)
    if (!text) return this.showToast('no entity path')
    try {
      await navigator.clipboard.writeText(text)
      this.showToast(`copied ${text}`)
    } catch {
      this.showToast('clipboard copy failed')
    }
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
    if (col.stage) {
      const mod = this.viewMods[col.stage] ?? await this.ensureView(col.stage)
      if (typeof mod?.views?.copy === 'function') {
        try { return this.clipboardValue(await mod.views.copy(row.doc)) } catch { /* use display/persisted fallback */ }
      }
      if (typeof mod?.views?.text === 'function') {
        try { return this.clipboardValue(await mod.views.text(row.doc)) } catch { /* use persisted fallback */ }
      }
      return this.clipboardValue(getPath(row.doc, await this.stageWritePath(col.stage)))
    }
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
    // Stage cells: ask the view to begin an in-cell edit (no field overlay).
    if (col?.stage) {
      const i = a.r - this.winStart
      const row = this.rows[i]; if (!row) return
      const mod = this.viewMods[col.stage]
      if (typeof mod?.views?.beginEdit === 'function') {
        try {
          mod.views.beginEdit(this.makeStageViewCtx(row, a.c, col.stage), replaceWith)
        } catch (err) {
          console.warn('views.beginEdit failed', col.stage, err)
        }
      }
      return
    }
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
      this.scheduleStageMounts()
      this.showToast(`saved ${ed.id}.yaml`)
    } catch (error) {
      this.showToast(error.message ?? 'save failed')
    }
  },
  cellDbl(i, ci) {
    this.sel.active = { r: this.absRow(i), c: ci }
    const col = this.columns[ci]
    if (col?.stage) {
      // Prefer view-owned beginEdit; otherwise no-op (stage cells are not field overlays).
      this.startEditActive()
      return
    }
    this.startEditActive()
  },

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
      this.redrawUi()
    })
  },
  // m-js full redraw rebuilds the DOM and resets scroll containers; snapshot/restore.
  // CRITICAL: never yank grid scrollTop back to a stale snap while the user is flinging —
  // that was the scrollbar "recoil". Prefer live _scrollTop; skip follow-up if user moved.
  preserveUiScroll(run) {
    if (this._preservingScroll) return run()
    this._preservingScroll = true
    const grid = document.querySelector('.gridwrap')
    const log = document.querySelector('.logbox')
    const chat = document.querySelector('.chat .messages')
    const nearBottom = (el, pad = 40) => !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= pad
    // Prefer the scroll position the user is driving (onScroll), not a possibly-stale DOM read.
    const gTop = this._scrollTop ?? grid?.scrollTop ?? 0
    const gLeft = this._scrollLeft ?? grid?.scrollLeft ?? 0
    const snap = {
      gTop,
      gLeft,
      gridUserAt: this._gridUserScrollAt ?? 0,
      logTop: log?.scrollTop ?? 0,
      logPinned: this.logPinned,
      logUserAt: this._logUserScrollAt ?? 0,
      chatTop: chat?.scrollTop ?? 0,
      chatPinned: nearBottom(chat),
    }
    try { run() } finally { this._preservingScroll = false }
    this.restoreUiScroll(snap, { followUp: false })
    // Follow-up only for log/chat layout; grid is restored once and then left alone
    // unless the user has not scrolled since the snap (see restoreUiScroll).
    this._scrollRestoreGen = (this._scrollRestoreGen ?? 0) + 1
    const gen = this._scrollRestoreGen
    requestAnimationFrame(() => {
      if (gen !== this._scrollRestoreGen) return
      this.restoreUiScroll(snap, { followUp: true })
      // Scroll events during redraw only set the dirty flag — run ensure now.
      if (this._scrollDirty && !this._scrollRaf) {
        this._scrollRaf = requestAnimationFrame(() => {
          this._scrollRaf = 0
          if (!this._scrollDirty) return
          this.ensureWindow({ reset: false })
        })
      }
    })
  },
  restoreUiScroll(snap, { followUp = false } = {}) {
    const g = document.querySelector('.gridwrap')
    if (g) {
      const userScrolledSince = (this._gridUserScrollAt ?? 0) > (snap.gridUserAt ?? 0)
      // Follow-up must never yank the grid mid-fling (primary recoil cause).
      if (followUp && userScrolledSince) {
        // leave grid where the user put it
      } else {
        // Live user intent always wins; snap is only a fallback.
        const top = this._scrollTop ?? snap.gTop
        const left = this._scrollLeft ?? snap.gLeft
        if (Math.abs((g.scrollTop ?? 0) - top) > 0.5 || Math.abs((g.scrollLeft ?? 0) - left) > 0.5) {
          this._programmaticGridScroll = true
          try {
            g.scrollTop = top
            g.scrollLeft = left
          } finally {
            this._programmaticGridScroll = false
          }
        }
        this._scrollTop = g.scrollTop
        this._scrollLeft = g.scrollLeft
      }
    }
    const l = document.querySelector('.logbox')
    if (l) {
        if (this._fullLoaded && this._canFullLoad()) {
          this.scheduleStageMounts()
          return
        }
      if (snap.logPinned && this.logPinned) {
        this._logProgrammaticScroll = true
        l.scrollTop = l.scrollHeight
        this._logProgrammaticScroll = false
      } else if (!userScrolledSince) {
        // only re-apply the pre-redraw offset when the user hasn't moved the log since
        this._logProgrammaticScroll = true
        l.scrollTop = snap.logTop
        this._logProgrammaticScroll = false
      }
      // follow-up must never re-pin or override a live user scroll
      if (!followUp && snap.logPinned) this.logPinned = true
    }
    const c = document.querySelector('.chat .messages')
    if (c) c.scrollTop = snap.chatPinned ? c.scrollHeight : snap.chatTop
  },
  redrawUi() { M.redraw() },
  isLogNearBottom(el, threshold = 40) {
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  },
  stickLogToBottom() {
    if (!this.logPinned) return
    const el = document.querySelector('.logbox')
    if (!el) return
    this._logProgrammaticScroll = true
    el.scrollTop = el.scrollHeight
    this._logProgrammaticScroll = false
    // second frame: reactive x-for may still be laying out new lines
    requestAnimationFrame(() => {
      const box = document.querySelector('.logbox')
      if (!box || !this.logPinned) return
      this._logProgrammaticScroll = true
      box.scrollTop = box.scrollHeight
      this._logProgrammaticScroll = false
    })
  },
  scheduleLogStick() {
    if (!this.logPinned || this._logStickPending) return
    this._logStickPending = true
    requestAnimationFrame(() => {
      this._logStickPending = false
      this.stickLogToBottom()
    })
  },
  magicPromptKey(ci, e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    e.stopPropagation()
    this.magicSubmit(ci)
  },
  async magicSubmit(ci) {
    const text = (this.magicInput[ci] ?? '').trim()
    if (!text || !this.canPersist()) return
    let col = this.columns[ci]
    let slug = col?.stage
    if (!slug) {
      // `ci` is a *visible* column index; server also needs full index when hidden
      // columns sit in the activity YAML (otherwise it hits the wrong slot).
      const fullColumn = this.fullIndexFromVisible(ci)
      if (fullColumn < 0) {
        this.showToast('could not resolve column for Angela')
        return
      }
      const authored = await fetch('/api/stage/from-prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          activity: this.actSlug,
          column: ci,
          fullColumn,
          prompt: text,
          revision: this.act?.revision ?? 0,
        }),
      })
      if (authored.status === 409) {
        this.markDesync()
        return
      }
      if (!authored.ok) {
        const error = await authored.json().catch(() => ({}))
        this.showToast(error.error ?? `could not create stage (${authored.status})`)
        return
      }
      const stage = await authored.json()
      slug = stage.slug
      await this.loadMeta()
    }
    this.magicInput[ci] = ''
    await this.chatSend(text, { stage: slug, newSession: true })
  },

  // Alt-click letter header cycles asc → desc → off (legacy shortcut).
  toggleSort(ci) {
    if (this.sort?.ci === ci) this.sort = this.sort.dir === 'asc' ? { ci, dir: 'desc' } : null
    else this.sort = { ci, dir: 'asc' }
    this.refreshWindow(true)
  },
  // Explicit A–Z / Z–A from the filter menu — always user-driven value sort.
  setSort(ci, dir) {
    if (dir !== 'asc' && dir !== 'desc') return
    this.sort = { ci, dir }
    this.filterMenu = null
    this.refreshWindow(true)
    M.redraw()
  },
  clearSort(ci) {
    if (this.sort?.ci === ci) this.sort = null
    this.filterMenu = null
    this.refreshWindow(true)
    M.redraw()
  },
  columnHasFilter(ci) {
    return !!String(this.colFilters?.[ci] ?? '').length || !!this.colFilterPicks?.[ci]?.length
  },
  // Filters are stored by column identity (stage slug / field path), not index, so
  // reordering or hiding columns cannot land a saved filter on a different column.
  _colKey(ci) {
    const col = this.columns?.[ci]
    if (!col) return null
    if (col.stage) return `stage:${col.stage}`
    if (col.field) return `field:${col.field}`
    return null
  },
  _readColFilterStore() {
    try { return JSON.parse(localStorage.getItem(COL_FILTER_KEY) || '{}') ?? {} }
    catch { return {} }
  },
  saveColFilters() {
    const slug = this.actSlug
    // Never write from a half-booted state — an empty columns list would persist
    // "no filters" and wipe the operator's saved view.
    if (!slug || !this.columns.length) return
    const entry = {}
    for (const [ciKey, pattern] of Object.entries(this.colFilters ?? {})) {
      const ci = Number(ciKey)
      const key = this._colKey(ci)
      const re = String(pattern ?? '')
      if (!key || !re) continue
      entry[key] = { re, not: !!this.colFilterNot?.[ci], picks: this.colFilterPicks?.[ci] ?? [] }
    }
    for (const [ciKey, picks] of Object.entries(this.colFilterPicks ?? {})) {
      const ci = Number(ciKey)
      const key = this._colKey(ci)
      if (!key || !picks?.length || entry[key]) continue
      entry[key] = { re: '', not: !!this.colFilterNot?.[ci], picks }
    }
    try {
      const all = this._readColFilterStore()
      if (Object.keys(entry).length) all[slug] = entry
      else delete all[slug]
      localStorage.setItem(COL_FILTER_KEY, JSON.stringify(all))
    } catch { /* storage unavailable */ }
  },
  restoreColFilters() {
    // Columns arrive with meta; before that there is nothing to key filters to.
    if (!this.columns.length) return
    const entry = this._readColFilterStore()[this.actSlug] ?? {}
    const filters = {}
    const nots = {}
    const picks = {}
    this.columns.forEach((col, ci) => {
      const key = this._colKey(ci)
      const saved = key ? entry[key] : null
      if (!saved) return
      const savedPicks = Array.isArray(saved.picks) ? saved.picks.map(String) : []
      if (savedPicks.length) picks[ci] = savedPicks
      const re = String(saved.re ?? '')
      if (re) {
        // A pattern that no longer compiles would hide every row — drop it silently.
        try { new RegExp(re); filters[ci] = re } catch { /* stale pattern */ }
      }
      if (saved.not && (filters[ci] || savedPicks.length)) nots[ci] = true
    })
    this.colFilters = filters
    this.colFilterNot = nots
    this.colFilterPicks = picks
  },
  // ---- top values (facet checkboxes) ----
  async loadColumnValues(ci) {
    const col = this.columns?.[ci]
    if (!col) return
    this.filterValues = { ci, loading: true, items: [], sampled: 0, distinct: 0 }
    M.redraw()
    const path = await this.valuePathForColumn(ci)
    const params = new URLSearchParams({
      activity: this.actSlug ?? '',
      stage: col.stage ?? '',
      path: path ?? '',
      limit: '12',
    })
    try {
      const data = await (await fetch(`/api/column/values?${params}`)).json()
      if (this.filterMenu?.ci !== ci) return // menu moved on while we were fetching
      this.filterValues = {
        ci,
        loading: false,
        items: data.values ?? [],
        sampled: data.sampled ?? 0,
        distinct: data.distinct ?? 0,
      }
    } catch {
      this.filterValues = { ci, loading: false, items: [], sampled: 0, distinct: 0 }
    }
    // The facet response often lands inside the normal redraw cooldown after
    // opening the menu. Force this one completion paint so Top values appears.
    M.redraw({ force: true })
  },
  valuePct(item) {
    const sampled = this.filterValues?.sampled ?? 0
    if (!sampled) return 0
    return Math.round((Number(item?.count ?? 0) / sampled) * 1000) / 10
  },
  get filterValuesOtherPct() {
    const shown = (this.filterValues?.items ?? []).reduce((sum, item) => sum + Number(item.count ?? 0), 0)
    const sampled = this.filterValues?.sampled ?? 0
    if (!sampled) return 0
    return Math.round(((sampled - shown) / sampled) * 1000) / 10
  },
  isValuePicked(ci, value) {
    return (this.colFilterPicks?.[ci] ?? []).includes(value)
  },
  toggleValuePick(ci, value) {
    const current = this.colFilterPicks?.[ci] ?? []
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    const map = { ...(this.colFilterPicks ?? {}) }
    if (next.length) map[ci] = next
    else delete map[ci]
    this.colFilterPicks = map
    this.saveColFilters()
    this.refreshWindow(this.filterMenu?.ci === ci ? false : true)
    M.redraw()
  },
  // NOT inverts the column predicate server-side. Toggling only costs a refetch
  // when a pattern is actually applied — inverting an empty filter is a no-op.
  toggleFilterNot(ci) {
    const next = { ...(this.colFilterNot ?? {}) }
    if (next[ci]) delete next[ci]
    else next[ci] = true
    this.colFilterNot = next
    this.saveColFilters()
    if (this.columnHasFilter(ci)) this.refreshWindow(this.filterMenu?.ci === ci ? false : true)
    M.redraw()
  },
  openFilterMenu(ci, e) {
    e?.stopPropagation?.()
    e?.preventDefault?.()
    if (this.filterMenu?.ci === ci) {
      this.closeFilterMenu()
      return
    }
    // Switching columns: flush the previous draft first.
    if (this.filterMenu && this.filterMenu.ci !== ci) {
      if (this._filterDebounce) {
        clearTimeout(this._filterDebounce)
        this._filterDebounce = null
      }
      this.applyFilterDraft(this.filterMenu.ci, this.filterDraft, { immediate: true })
    }
    this.filterMenu = { ci }
    this.filterDraft = this.colFilters?.[ci] ?? ''
    this.loadColumnValues(ci)
    this._bindFilterMenuOutside()
    M.redraw()
    setTimeout(() => document.querySelector('.col-filter-menu input.filter-re')?.focus(), 0)
  },
  _bindFilterMenuOutside() {
    // m-js @click.outside calls the handler without `this`, so we bind our own
    // document listener while the menu is open.
    if (this._filterOutsideBound) return
    this._filterOutsideBound = true
    this._onFilterOutside = (ev) => {
      if (!this.filterMenu) return
      const t = ev.target
      // One menu node exists per column (x-for); do not querySelector the first hidden one.
      if (t?.closest?.('.col-filter-menu') || t?.closest?.('.filter-btn')) return
      this.closeFilterMenu()
    }
    // next tick so the opening click does not immediately close
    setTimeout(() => {
      if (this.filterMenu) document.addEventListener('click', this._onFilterOutside, true)
    }, 0)
  },
  _unbindFilterMenuOutside() {
    if (!this._filterOutsideBound) return
    document.removeEventListener('click', this._onFilterOutside, true)
    this._filterOutsideBound = false
    this._onFilterOutside = null
  },
  closeFilterMenu() {
    if (!this.filterMenu) return
    if (this._filterDebounce) {
      clearTimeout(this._filterDebounce)
      this._filterDebounce = null
    }
    // Flush any pending draft before close so a quick close still applies.
    this.applyFilterDraft(this.filterMenu.ci, this.filterDraft, { immediate: true })
    this.filterMenu = null
    this._unbindFilterMenuOutside()
    M.redraw()
  },
  onFilterDraftInput(ci, value) {
    this.filterDraft = value
    this.applyFilterDraft(ci, value, { immediate: false })
  },
  applyFilterDraft(ci, value, { immediate = false } = {}) {
    if (this._filterDebounce) {
      clearTimeout(this._filterDebounce)
      this._filterDebounce = null
    }
    const run = async () => {
      this._filterDebounce = null
      const text = String(value ?? '')
      const next = { ...this.colFilters }
      if (!text) delete next[ci]
      else {
        try {
          new RegExp(text)
          next[ci] = text
        } catch {
          // Keep draft visible but don't apply invalid regex (would hide all rows).
          this.showToast('invalid regex')
          return
        }
      }
      const prev = this.colFilters?.[ci] ?? ''
      const applied = next[ci] ?? ''
      if (prev === applied) return
      // m-js redraw restores focus only by id/name — give the filter input a stable id.
      const id = `sheets-col-filter-${ci}`
      const active = document.activeElement
      const keepFocus = active?.id === id || (active?.classList?.contains('filter-re') && this.filterMenu?.ci === ci)
      const selStart = keepFocus ? active.selectionStart : null
      const selEnd = keepFocus ? active.selectionEnd : null
      this.colFilters = next
      this.saveColFilters()
      // Keep grid scroll when filtering from the open menu.
      await this.refreshWindow(this.filterMenu?.ci === ci ? false : true)
      M.redraw()
      if (keepFocus && this.filterMenu?.ci === ci) {
        const restore = () => {
          const input = document.getElementById(id)
          if (!input || this.filterMenu?.ci !== ci) return
          if (document.activeElement !== input) input.focus()
          try {
            if (selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd)
          } catch { /* ignore */ }
        }
        restore()
        requestAnimationFrame(restore)
      }
    }
    if (immediate) run()
    else this._filterDebounce = setTimeout(run, 500)
  },
  clearFilterInput(ci) {
    if (this._filterDebounce) {
      clearTimeout(this._filterDebounce)
      this._filterDebounce = null
    }
    this.filterDraft = ''
    this.applyFilterDraft(ci, '', { immediate: true })
    M.redraw() // hide the × even when no applied filter changed
    // Keep menu open and put caret back in the field.
    requestAnimationFrame(() => {
      const input = document.getElementById(`sheets-col-filter-${ci}`)
      if (input && this.filterMenu?.ci === ci) input.focus()
    })
  },
  clearColumnFilter(ci) {
    if (this._filterDebounce) {
      clearTimeout(this._filterDebounce)
      this._filterDebounce = null
    }
    this.filterDraft = ''
    if (!this.columnHasFilter(ci)) {
      this.filterMenu = null
      M.redraw()
      return
    }
    const next = { ...this.colFilters }
    delete next[ci]
    this.colFilters = next
    const nextNot = { ...(this.colFilterNot ?? {}) }
    delete nextNot[ci]
    this.colFilterNot = nextNot
    const nextPicks = { ...(this.colFilterPicks ?? {}) }
    delete nextPicks[ci]
    this.colFilterPicks = nextPicks
    this.saveColFilters()
    this.filterMenu = null
    this.refreshWindow(true)
    M.redraw()
  },

  // ---- run bar ----
  async play() {
    if (!this.sel.ranges.length) return this.showToast('nothing selected')
    // Resolve cells client-side against the visible grid (same order as the play summary).
    // Server-side A1 re-resolve can disagree after hidden columns / sort / search.
    const rows = await this.selectedRows()
    const cells = []
    const seen = new Set()
    let skippedFields = 0
    for (const [rowIndex, columnIndex] of this.selectedCellCoords()) {
      const row = rows.get(rowIndex)
      const col = this.columns[columnIndex]
      if (!row) continue
      if (!col?.stage) {
        skippedFields++
        continue
      }
      const key = `${row.id}|${col.stage}`
      if (seen.has(key)) continue
      seen.add(key)
      cells.push({ id: row.id, stage: col.stage })
    }
    if (!cells.length) {
      if (skippedFields) return this.showToast('no playable stage cells in selection (field columns are not playable)')
      return this.showToast('no playable cells in selection')
    }
    const r = await (await fetch('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: this.actSlug, cells }),
    })).json()
    if (!r.ok && r.error) return this.showToast(r.error)
    this.showToast(`enqueued ${r.added ?? cells.length}`)
  },
  async stopAll() { await fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) }) },

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
        const params = await this.entityParams(offset, limit)
        const data = await (await fetch(`/api/entities?${params}`)).json()
        data.rows.forEach((row, index) => rows.set(offset + index, row))
      }
    }
    return rows
  },
  async selectedRowIds() {
    const rows = await this.selectedRows()
    return [...rows.values()].map((row) => row.id)
  },
  // Path relative to the activity's entity db root (for confirm dialogs).
  entityPathRelativeToDb(row) {
    const source = this.act?.source
    if (row?.file && source) {
      const root = String(source).replace(/\/+$/, '')
      if (row.file === root) return row.id ? `${row.id}.yaml` : '.'
      if (row.file.startsWith(`${root}/`)) return row.file.slice(root.length + 1)
    }
    if (row?.file) {
      const slash = row.file.lastIndexOf('/')
      return slash >= 0 ? row.file.slice(slash + 1) : row.file
    }
    return row?.id ? `${row.id}.yaml` : '(unknown)'
  },
  async deleteRows() {
    if (!this.canPersist()) return
    if (!this.sel.ranges.length) return this.showToast('select one or more rows first')
    const selected = await this.selectedRows()
    const rows = [...selected.values()]
    const ids = rows.map((row) => row.id)
    if (!ids.length) return this.showToast('no rows selected')
    const paths = rows.map((row) => this.entityPathRelativeToDb(row))
    const preview = paths.slice(0, 10)
    const more = paths.length > 10 ? `\n… and ${paths.length - 10} more` : ''
    const n = ids.length
    const msg = `Delete ${n} row${n === 1 ? '' : 's'} and ${n === 1 ? 'its' : 'their'} YAML file${n === 1 ? '' : 's'} from disk?\n\n${preview.join('\n')}${more}`
    if (!confirm(msg)) return
    const r = await (await fetch('/api/entities/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activity: this.actSlug, ids }),
    })).json()
    if (!r.ok) return this.showToast(r.error ?? 'could not delete rows')
    this.sel = { ranges: [], active: null, anchor: null }
    await this.refreshWindow(false)
    M.redraw()
    this.showToast(`deleted ${r.deleted.length} row${r.deleted.length === 1 ? '' : 's'}`)
  },
  get hasRowSelection() {
    return !!(this.sel?.ranges?.length)
  },
  async duplicateRows() {
    if (!this.canPersist()) return
    if (!this.sel.ranges.length) return this.showToast('select one or more rows first')
    const ids = await this.selectedRowIds()
    if (!ids.length) return this.showToast('no rows selected')
    const r = await (await fetch('/api/entities/duplicate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: this.actSlug, ids }),
    })).json()
    if (!r.ok) return this.showToast(r.error ?? 'could not duplicate rows')
    await this.refreshWindow(false)
    M.redraw()
    const n = r.created?.length ?? 0
    this.showToast(n === 1 ? `duplicated ${r.created[0].from} → ${r.created[0].id}` : `duplicated ${n} rows`)
  },

  // ---- columns (toolbar) ----
  // Visibility toggles flip `hidden` in the full ordered list (order preserved in activity YAML).
  async toggleFieldColumn(f) {
    if (!this.canPersist()) return
    const columns = copyColumns(this.fullColumns)
    const idx = columns.findIndex((c) => c.field === f)
    if (idx >= 0) this.setColumnHidden(columns[idx], !columns[idx].hidden)
    else columns.push({ field: f })
    await this.patchColumns(columns)
  },
  hasFieldColumn(f) { return this.columns.some((c) => c.field === f) },
  async insertColumn() {
    const at = (this.sel.active?.c ?? this.columns.length - 1) + 1
    const columns = copyColumns(this.fullColumns)
    columns.splice(this.fullInsertIndex(at), 0, {})
    await this.patchColumns(columns)
  },
  async deleteColumn() {
    const ci = this.sel.active?.c
    if (ci == null) return this.showToast('select a cell in the column first')
    const col = this.columns[ci]
    if (col?.stage && !confirm(`Remove column ${colLetter(ci)}? Stage '${col.stage}' stays available for other activities.`)) return
    const columns = copyColumns(this.fullColumns)
    const fi = this.fullIndexFromVisible(ci)
    if (fi < 0) return
    columns.splice(fi, 1)
    await this.patchColumns(columns)
  },
  async moveColumn(ci, delta) {
    const target = ci + delta
    if (target < 0 || target >= this.columns.length) return
    const columns = copyColumns(this.fullColumns)
    const from = this.fullIndexFromVisible(ci)
    const to = this.fullIndexFromVisible(target)
    if (from < 0 || to < 0) return
    const [column] = columns.splice(from, 1)
    // After removal, insert so the column lands at the target's slot among the full list.
    columns.splice(to, 0, column)
    try {
      await this.patchColumns(columns)
      M.redraw()
    } catch (error) {
      this.showToast(error.message ?? 'could not move column')
    }
  },
  async patchColumns(columns, componentLocks = this.componentLocks) {
    // Normalize: never persist hidden:false
    const normalized = columns.map((c) => {
      const next = { ...c }
      if (!next.hidden) delete next.hidden
      return next
    })
    const result = await this.persistActivity({ columns: normalized, componentLocks })
    if (!result) return false
    const activity = this.meta?.activities?.find((entry) => entry.slug === this.actSlug)
    if (activity) {
      activity.columns = normalized
      activity.componentLocks = componentLocks
      activity.revision = result.revision ?? activity.revision + 1
    }
    this.componentLocks = componentLocks
    this.redrawGrid()
    return true
  },
  redrawGrid() {
    M.redraw()
    this.scheduleStageMounts()
  },
  componentChecked(group) { return group.fields.length > 0 && group.fields.every((field) => this.hasFieldColumn(field.path)) },
  async toggleComponent(group) {
    if (!this.canPersist()) return
    const show = !this.componentChecked(group)
    const paths = new Set(group.fields.map((field) => field.path))
    const columns = copyColumns(this.fullColumns)
    for (const column of columns) {
      if (column.field && paths.has(column.field)) this.setColumnHidden(column, !show)
    }
    if (show) {
      for (const path of paths) {
        if (!columns.some((column) => column.field === path)) columns.push({ field: path })
      }
    }
    // Component selections are bulk actions, not persistent input locks.
    await this.patchColumns(columns, {})
    M.redraw()
  },
  async toggleFieldPath(path) { await this.toggleFieldColumn(path) },
  hasStageColumn(slug) { return this.columns.some((column) => column.stage === slug) },
  async toggleStageColumn(slug) {
    if (!this.canPersist()) return
    const columns = copyColumns(this.fullColumns)
    const index = columns.findIndex((column) => column.stage === slug)
    if (index >= 0) this.setColumnHidden(columns[index], !columns[index].hidden)
    else columns.push({ stage: slug })
    await this.patchColumns(columns)
  },
  // Column menu group bulk select: hide/show without dropping order from activity YAML.
  async setStageColumnsVisible(show) {
    if (!this.canPersist()) return
    const stageSlugs = new Set((this.stageTree ?? []).map((s) => s.slug))
    const columns = copyColumns(this.fullColumns)
    for (const c of columns) {
      if (c.stage && stageSlugs.has(c.stage)) this.setColumnHidden(c, !show)
    }
    if (show) {
      for (const stage of this.stageTree ?? []) {
        if (!columns.some((c) => c.stage === stage.slug)) columns.push({ stage: stage.slug })
      }
    }
    await this.patchColumns(columns)
    M.redraw()
  },
  async setFieldColumnsVisible(show) {
    if (!this.canPersist()) return
    const allPaths = []
    for (const group of this.fieldTree ?? []) {
      for (const field of group.fields ?? []) allPaths.push(field.path)
    }
    const pathSet = new Set(allPaths)
    const columns = copyColumns(this.fullColumns)
    for (const c of columns) {
      if (c.field && pathSet.has(c.field)) this.setColumnHidden(c, !show)
    }
    if (show) {
      for (const path of allPaths) {
        if (!columns.some((c) => c.field === path)) columns.push({ field: path })
      }
    }
    // Clear component locks so individual field checkboxes stay interactive.
    await this.patchColumns(columns, {})
    M.redraw()
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
    const columns = copyColumns(this.fullColumns)
    const fi = this.fullIndexFromVisible(edit.ci)
    if (fi < 0) return
    const prev = columns[fi] ?? {}
    const next = { field }
    if (prev.width != null) next.width = prev.width
    if (prev.hidden) next.hidden = true
    columns[fi] = next
    if (!await this.patchColumns(columns)) return
    this.filterMenu = null
    this.sort = null
    this.colFilters = {}
    this.colFilterNot = {}
    this.colFilterPicks = {}
    this.saveColFilters()
    this._colValuePath = {}
    M.redraw()
    this.showToast(`saved ${field}`)
  },

  // ---- tabs (Δ) ----
  async switchTab(slug) {
    if (slug === this.actSlug) return this.startTabRename(slug)
    this.actSlug = slug
    this.tabMenu = null
    this.filterMenu = null
    this.loadPaginationPrefs()
    this.restoreColFilters()
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
    // Optimistic concurrency must use the target tab's revision, not the active tab's.
    const response = await fetch(
      `/api/activity/${encodeURIComponent(slug)}?revision=${activity.revision ?? 0}`,
      { method: 'DELETE' },
    )
    const result = await response.json().catch(() => ({}))
    if (response.status === 409) {
      this.markDesync()
      return this.showToast(result.error ?? 'activity changed on disk — reload and try again')
    }
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
      if (ev.slug === this.actSlug && Number(ev.revision) === Number(this.act?.revision)) return
      // Activity YAML changed (columns etc.) — meta refresh is enough; avoid scroll churn.
      await this.loadMeta(false)
      this.redrawGrid()
    } else if (ev.resource === 'stage') {
      // Coalesce with chat-side reloads; one fetch + one paint (no meta thrash).
      this.scheduleStageViewReload(ev.slug)
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
      // Stage columns never participate in generic blank — views handle Delete themselves.
      if (column.stage) continue
      let fields = []
      if (column.field) fields = [column.field]
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
    this.wsConnecting = true
    M.redraw()
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/run`)
    ws.onopen = () => { this.wsConnecting = false; this.wsConnected = true; M.redraw() }
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
      this.wsConnecting = false
      this.wsConnected = false
      M.redraw()
      setTimeout(() => this.connectWS(), 2000)
    }
  },
  pushLog(ev) {
    this.logs.push(ev)
    if (this.logs.length > 500) this.logs.shift()
    this.scheduleLogStick()
  },
  logScroll(e) {
    // Ignore programmatic stick-to-bottom / post-redraw restores so they don't unpin.
    if (this._logProgrammaticScroll) return
    this._logUserScrollAt = performance.now()
    this.logPinned = this.isLogNearBottom(e.currentTarget)
  },
  logWheel(e) {
    // Wheel fires before scroll position updates; mark user intent and re-check pin after.
    this._logUserScrollAt = performance.now()
    requestAnimationFrame(() => {
      const el = document.querySelector('.logbox')
      if (!el) return
      this.logPinned = this.isLogNearBottom(el)
    })
  },
  logPlainText(ev) {
    const ts = new Date(ev.ts).toTimeString().slice(0, 8)
    return `${ts} ${ev.stage ?? ''} ${ev.entity ?? ''} ${ev.line ?? ''}`
  },
  logHtml(ev) {
    const ts = new Date(ev.ts).toTimeString().slice(0, 8)
    return `<span class="ts">${ts}</span> <span style="color:${hashColor(ev.stage)}">${esc(ev.stage)}</span> <span style="color:${hashColor(ev.entity)}">${esc(ev.entity)}</span> ${esc(ev.line)}`
  },
  onLogFilterInput(value) {
    this.logFilterDraft = value
    this.applyLogFilter(value, { immediate: false })
  },
  clearLogFilter() {
    if (this._logFilterDebounce) {
      clearTimeout(this._logFilterDebounce)
      this._logFilterDebounce = null
    }
    this.logFilterDraft = ''
    this.applyLogFilter('', { immediate: true })
    M.redraw()
    requestAnimationFrame(() => document.getElementById('sheets-log-filter-input')?.focus())
  },
  applyLogFilter(value, { immediate = false } = {}) {
    if (this._logFilterDebounce) {
      clearTimeout(this._logFilterDebounce)
      this._logFilterDebounce = null
    }
    const run = () => {
      this._logFilterDebounce = null
      const text = String(value ?? '')
      if (text) {
        try {
          new RegExp(text)
        } catch {
          // Keep draft visible but don't apply invalid regex (would hide all lines).
          this.showToast('invalid regex')
          return
        }
      }
      if ((this.logFilterRe ?? '') === text) return
      this.logFilterRe = text
      M.redraw()
      this.scheduleLogStick()
    }
    if (immediate) run()
    else this._logFilterDebounce = setTimeout(run, 1000)
  },
  get visibleLogs() {
    const src = this.logFilterRe ?? ''
    if (!src) return this.logs
    let re
    try {
      re = new RegExp(src)
    } catch {
      return this.logs
    }
    return this.logs.filter((ev) => re.test(this.logPlainText(ev)))
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
    this.logs = []
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
  async setConcurrency(value, { force = false } = {}) {
    const n = Math.max(0, Math.min(64, Math.round(Number(value) || 0)))
    if (!force && n === this.conc) return
    const previous = this.conc
    this.conc = n
    M.redraw()
    try {
      const response = await fetch('/api/queue/concurrency', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'could not update concurrency')
    } catch (error) {
      this.conc = previous
      M.redraw()
      this.showToast(error.message ?? 'could not update concurrency')
    }
  },
  sliderDown(e) {
    this.dragging = { x: e.clientX, v: this.conc }
    const move = (ev) => { if (this.dragging) { this.conc = Math.max(0, Math.min(64, Math.round(this.dragging.v + (ev.clientX - this.dragging.x) / 3))); M.redraw() } }
    const up = async () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      const n = this.conc; this.dragging = null
      await this.setConcurrency(n, { force: true })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  },

  // ---- chat (Ε/Θ) ----
  loadChatPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem('sheets-chat') || '{}')
      this.chat.model = String(prefs.model ?? '')
      this.chat.reasoningEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(prefs.reasoningEffort) ? prefs.reasoningEffort : 'medium'
      this.chat.thinking = prefs.thinking === true
      this.chat.speak = prefs.speak === true
      this.sidebarWidth = Number(prefs.sidebarWidth) || 0
      this.logHeight = Number(prefs.logHeight) || 180
      this.logWrap = prefs.logWrap === true
    } catch {}
  },
  persistChatPrefs() {
    try {
      localStorage.setItem('sheets-chat', JSON.stringify({
        model: this.chat.model, reasoningEffort: this.chat.reasoningEffort,
        thinking: this.chat.thinking, speak: this.chat.speak,
        sidebarWidth: this.sidebarWidth, logHeight: this.logHeight,
        logWrap: this.logWrap === true,
      }))
    } catch {}
  },
  toggleLogWrap() {
    this.logWrap = !this.logWrap
    this.persistChatPrefs()
  },
  sidebarStyle() {
    return this.sidebarWidth > 0 ? { width: `${this.sidebarWidth}px`, flex: '0 0 auto' } : {}
  },
  logStyle() {
    return { height: `${this.logHeight}px`, flex: '0 0 auto' }
  },
  startSidebarWidthResize(e) {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sidebar = document.querySelector('.sidebar')
    const startW = sidebar?.getBoundingClientRect().width ?? 320
    const startX = e.clientX
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    this.resizing = true
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    const move = (event) => {
      const max = Math.max(360, window.innerWidth - 360)
      this.sidebarWidth = Math.max(300, Math.min(max, startW + startX - event.clientX))
      M.redraw()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.resizing = false
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      this.persistChatPrefs()
      M.redraw()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  },
  startChatResize(e) {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sidebar = document.querySelector('.sidebar')
    const logbox = document.querySelector('.logbox')
    const queuebox = document.querySelector('.queuebox')
    const startH = logbox?.getBoundingClientRect().height ?? this.logHeight
    const startY = e.clientY
    const sidebarH = sidebar?.getBoundingClientRect().height ?? window.innerHeight
    const queueH = queuebox?.getBoundingClientRect().height ?? 48
    const max = Math.max(80, sidebarH - queueH - 6 - 180)
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    this.resizing = true
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    const move = (event) => {
      this.logHeight = Math.max(80, Math.min(max, startH + event.clientY - startY))
      M.redraw()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.resizing = false
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      this.persistChatPrefs()
      M.redraw()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  },
  async loadChatConfig() {
    try {
      const response = await fetch('/api/chat/config')
      if (!response.ok) throw new Error('chat config unavailable')
      const config = await response.json()
      this.chat.agents = config.agents ?? []
      this.chat.agent = config.agent ?? this.chat.agents[0]?.name ?? 'angela'
      this.chat.models = config.models ?? []
      if (!this.chat.model || !this.chat.models.includes(this.chat.model)) this.chat.model = config.model ?? this.chat.models[0] ?? ''
      if (this.chat.model && !this.chat.models.includes(this.chat.model)) this.chat.models.unshift(this.chat.model)
      this.chat.contextWindow = Number(config.contextWindow ?? 32768)
      this.chat.allowlist = String(config.allowlist ?? '')
      this.chat.allowlistBaseline = String(config.allowlistBaseline ?? config.allowlist ?? '')
      this.chat.allowlistOverridden = Boolean(config.allowlistOverridden)
      this.chat.toolsEnabled = config.toolsEnabled ?? null
      this.chat.toolsBaseline = config.toolsBaseline ?? null
      this.chat.toolsEnabledOverridden = Boolean(config.toolsEnabledOverridden)
      this.chat.thinking = config.thinking === true || this.chat.thinking
      this.chat.reasoningEffort = config.reasoningEffort ?? this.chat.reasoningEffort
      this.persistChatPrefs()
    } catch (error) {
      this.showToast(error.message ?? 'chat config unavailable')
    }
  },
  async resetChatSession() {
    try { await fetch('/api/chat/new', { method: 'POST' }) } catch {}
    this.chat.sessionId = null
  },
  chatAgentChange(e) {
    this.chat.agent = e.target.value
    this.resetChatSession()
  },
  chatModelChange(e) {
    this.chat.model = e.target.value
    this.persistChatPrefs()
    this.resetChatSession()
  },
  chatEffortChange(e) {
    this.chat.reasoningEffort = e.target.value
    this.persistChatPrefs()
  },
  toggleChatThinking() {
    this.chat.thinking = !this.chat.thinking
    this.persistChatPrefs()
  },
  toggleChatSpeak() {
    this.chat.speak = !this.chat.speak
    this.chat.speakWarning = false
    this.persistChatPrefs()
  },
  chatAllowlistInput(e) {
    if (e?.target) this.chat.allowlist = e.target.value
    this.chat.allowlistOverridden = this.chat.allowlist !== this.chat.allowlistBaseline
  },
  toggleChatAllowlist() {
    this.chat.allowlistOpen = !this.chat.allowlistOpen
    if (this.chat.allowlistOpen) this.chat.toolsOpen = false
  },
  async chatAllowlistBlur() {
    this.chatAllowlistInput()
    const response = await fetch('/api/chat/allowlist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowlist: this.chat.allowlist, overridden: this.chat.allowlistOverridden }),
    })
    if (!response.ok) this.showToast('could not update allowlist')
  },
  async resetChatAllowlist() {
    this.chat.allowlist = this.chat.allowlistBaseline
    this.chat.allowlistOverridden = false
    await this.chatAllowlistBlur()
  },
  async loadChatTools() {
    if (this.chat.toolsLoading) return
    this.chat.toolsLoading = true
    this.chat.toolsError = ''
    try {
      const response = await fetch('/api/chat/tools')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'tools unavailable')
      this.chat.tools = data.tools ?? []
      if (!this.chat.toolsEnabledOverridden) {
        this.chat.toolsEnabled = data.toolsEnabled ?? null
        this.chat.toolsBaseline = data.toolsEnabled ?? null
      }
    } catch (error) {
      this.chat.toolsError = error.message ?? 'tools unavailable'
    } finally {
      this.chat.toolsLoading = false
    }
  },
  toggleChatTools() {
    this.chat.toolsOpen = !this.chat.toolsOpen
    if (this.chat.toolsOpen) {
      this.chat.allowlistOpen = false
      this.loadChatTools()
    }
  },
  chatToolChecked(tool) {
    return this.chat.toolsEnabled == null || this.chat.toolsEnabled.includes(tool.name)
  },
  async setChatToolEnabled(name, enabled) {
    const names = this.chat.tools.map((tool) => tool.name)
    const selected = new Set(this.chat.toolsEnabled == null ? names : this.chat.toolsEnabled)
    if (enabled) selected.add(name)
    else selected.delete(name)
    this.chat.toolsEnabled = names.filter((toolName) => selected.has(toolName))
    this.chat.toolsEnabledOverridden = true
    await this.persistChatTools()
  },
  async persistChatTools() {
    const response = await fetch('/api/chat/tools-enabled', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolsEnabled: this.chat.toolsEnabled, overridden: this.chat.toolsEnabledOverridden }),
    })
    if (!response.ok) this.showToast('could not update tools')
  },
  async enableAllChatTools() {
    this.chat.toolsEnabled = this.chat.tools.map((tool) => tool.name)
    this.chat.toolsEnabledOverridden = true
    await this.persistChatTools()
  },
  async disableAllChatTools() {
    this.chat.toolsEnabled = []
    this.chat.toolsEnabledOverridden = true
    await this.persistChatTools()
  },
  async resetChatTools() {
    this.chat.toolsEnabled = this.chat.toolsBaseline
    this.chat.toolsEnabledOverridden = false
    await this.persistChatTools()
  },
  chatContextPct() {
    const max = Number(this.chat.contextWindow) || 0
    return max ? Math.min(100, Math.max(0, Number(this.chat.tokensUsed || 0) / max * 100)) : 0
  },
  chatContextLabel() {
    const used = Number(this.chat.tokensUsed || 0)
    if (used >= 1000) return `${(used / 1000).toFixed(used >= 10000 ? 0 : 1)}k`
    return String(used)
  },
  chatContextTitle() {
    const used = Number(this.chat.tokensUsed || 0)
    const max = Number(this.chat.contextWindow || 0)
    return `context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens`
  },
  chatApproval(event) {
    const existing = this.chat.messages.find((message) => message.who === 'approval' && message.approvalId === event.id)
    if (existing) {
      existing.status = 'pending'
      return
    }
    this.chat.messages.push({
      who: 'approval', body: '', approvalId: event.id, name: event.name ?? event.tool ?? 'tool',
      command: event.command ?? '', args: event.args ?? {}, reason: event.reason ?? 'not on allowlist',
      status: 'pending', visible: true, bookmarked: false,
    })
  },
  async chatApprove(message, decision) {
    const response = await fetch('/api/chat/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: message.approvalId, decision }),
    })
    const result = await response.json().catch(() => ({}))
    if (response.ok && result.ok) message.status = decision === 'allow' ? 'allowed' : 'denied'
    else message.status = 'error'
    M.redraw()
  },
  stripChatMarkup(text) {
    return String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/!?(\[[^\]]+\])\([^)]*\)/g, '$1').replace(/[\[\]*_~`>#]/g, '').replace(/\s+/g, ' ').trim()
  },
  async speakChatMessage(message) {
    if (!this.chat.speak || !message?.body || message.body.startsWith('⚠') || message.body.startsWith('(stopped)')) return
    const text = this.stripChatMarkup(message.body)
    if (!text) return
    try {
      const response = await fetch(`/speak?text=${encodeURIComponent(text.slice(0, 4000))}`)
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.error) this.chat.speakWarning = true
    } catch { this.chat.speakWarning = true }
    M.redraw()
  },
  formatChatElapsed(ms) { return `${(Math.max(0, ms) / 1000).toFixed(3)}s` },
  startChatClock() {
    this.stopChatClock(false)
    this.chat.startedAt = performance.now()
    this._chatClockGen = (this._chatClockGen ?? 0) + 1
    const gen = this._chatClockGen
    const tick = () => {
      if (gen !== this._chatClockGen) return // stopped or superseded
      this.chat.elapsed = this.formatChatElapsed(performance.now() - this.chat.startedAt)
      // Direct DOM patch every frame — never full M.redraw (destroys the whole grid).
      const el = document.querySelector('.chat-elapsed')
      if (el) {
        el.textContent = this.chat.elapsed
        el.hidden = false
        el.style.display = ''
      }
      this.chat.timer = requestAnimationFrame(tick)
    }
    this.chat.timer = requestAnimationFrame(tick)
  },
  stopChatClock(freeze = true) {
    this._chatClockGen = (this._chatClockGen ?? 0) + 1 // invalidate in-flight rAF ticks
    if (this.chat.timer) {
      cancelAnimationFrame(this.chat.timer)
      try { clearInterval(this.chat.timer) } catch { /* legacy */ }
    }
    this.chat.timer = null
    if (freeze && this.chat.startedAt) this.chat.elapsed = this.formatChatElapsed(performance.now() - this.chat.startedAt)
    if (!freeze) this.chat.elapsed = ''
    const el = document.querySelector('.chat-elapsed')
    if (el && this.chat.elapsed) el.textContent = this.chat.elapsed
  },
  updateChatTelemetry(message, patch = {}) {
    if (!message) return
    const telemetry = message.telemetry ??= { startedAt: this.chat.startedAt }
    const now = performance.now()
    if (!telemetry.startedAt) telemetry.startedAt = this.chat.startedAt || now
    telemetry.elapsedMs = Math.max(0, now - telemetry.startedAt)
    if (message.body && !telemetry.firstTokenAt) {
      telemetry.firstTokenAt = now
      telemetry.ttftMs = telemetry.firstTokenAt - telemetry.startedAt
    }
    const estimatedTokens = Math.max(0, Math.ceil(String(message.body ?? '').replace(/\s+/g, ' ').trim().length / 4))
    if (estimatedTokens) telemetry.estimatedTokens = estimatedTokens
    const completionTokens = patch.completionTokens ?? patch.completion_tokens
    if (completionTokens != null && Number.isFinite(Number(completionTokens))) telemetry.completionTokens = Number(completionTokens)
    const tokPerSec = patch.tokPerSec ?? patch.tok_per_sec
    if (tokPerSec != null && Number.isFinite(Number(tokPerSec))) telemetry.tokPerSec = Number(tokPerSec)
    const ttftMs = patch.ttftMs ?? patch.ttft_ms
    if (ttftMs != null && Number.isFinite(Number(ttftMs))) telemetry.ttftMs = Number(ttftMs)
    const finishReason = patch.finishReason ?? patch.finish_reason ?? patch.stop_reason
    if (finishReason) telemetry.finishReason = String(finishReason)
    if (patch.error) telemetry.error = String(patch.error)
    if (telemetry.tokPerSec == null && telemetry.estimatedTokens && telemetry.elapsedMs > 0) {
      telemetry.tokPerSec = telemetry.estimatedTokens / (telemetry.elapsedMs / 1000)
    }
  },
  chatTelemetryHtml(message) {
    const t = message?.telemetry
    if (!t) return ''
    const chip = (icon, text) => `<span class="metric-chip"><i class="ph-bold ${icon}" aria-hidden="true"></i><span>${esc(text)}</span></span>`
    const chips = []
    if (t.tokPerSec != null && Number.isFinite(Number(t.tokPerSec))) chips.push(chip('ph-gauge', `${Number(t.tokPerSec).toFixed(2)} tps`))
    const tokenCount = t.completionTokens ?? t.estimatedTokens
    if (tokenCount > 0) chips.push(chip('ph-text-aa', `${t.completionTokens == null ? '~' : ''}${tokenCount} tok`))
    if (t.ttftMs != null && Number.isFinite(Number(t.ttftMs))) chips.push(chip('ph-timer', `${(Number(t.ttftMs) / 1000).toFixed(2)}s ttft`))
    const finish = t.finishReason || (t.error ? 'error' : '')
    if (finish) chips.push(chip('ph-flag-banner', `finish: ${finish}`))
    if (t.error) chips.push(chip('ph-warning', t.error.slice(0, 40)))
    return chips.join('')
  },
  toggleChatMessageVisible(message) {
    if (!message) return
    message.visible = message.visible === false
    M.redraw()
  },
  toggleChatMessageBookmark(message) {
    if (!message) return
    message.bookmarked = !message.bookmarked
    M.redraw()
  },
  async chatStop() {
    if (!this.chat.busy) return
    this.chat.stopRequested = true
    try { await fetch('/api/chat/abort', { method: 'POST' }) } catch {}
  },
  focusedStage() {
    if (this.focus) return this.focus.slug
    const c = this.sel.active?.c
    return c != null ? this.columns[c]?.stage ?? null : null
  },
  async chatSend(text, opts = {}) {
    text = text ?? this.chat.input.trim()
    if (!text || this.chat.busy) return
    this.chat.input = ''
    this.chat.messages.push({ who: 'you', body: text, visible: true, bookmarked: false })
    this.startChatClock()
    const asst = { who: 'angela', body: '', events: [], visible: true, bookmarked: false, telemetry: { startedAt: this.chat.startedAt } }
    this.chat.messages.push(asst)
    this.chat.busy = true
    const stageForTurn = opts.stage ?? this.focusedStage()
    try {
      const sample = this.rows[0]?.doc ?? null
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: text, activity: this.actSlug, selection: this.selA1() || null,
          stage: stageForTurn, entitySample: sample,
          newSession: opts.newSession ?? false, agent: this.chat.agent, model: this.chat.model,
          thinking: this.chat.thinking, reasoning_effort: this.chat.reasoningEffort,
          allowlist: this.chat.allowlist, allowlistOverridden: this.chat.allowlistOverridden,
          toolsEnabled: this.chat.toolsEnabled, toolsEnabledOverridden: this.chat.toolsEnabledOverridden,
        }) })
      if (!res.ok || !res.body) throw new Error(await res.text() || `chat failed (${res.status})`)
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
          if (ev.type === 'session') {
            this.chat.sessionId = ev.id ?? null
            this.chat.agent = ev.agent ?? this.chat.agent
            this.chat.model = ev.model ?? this.chat.model
            this.chat.contextWindow = Number(ev.contextWindow ?? this.chat.contextWindow)
          } else if (ev.type === 'assistant_delta') {
            asst.body += ev.text
            this.updateChatTelemetry(asst)
          } else if (ev.type === 'error') {
            asst.body += `\n⚠ ${ev.error}`
            this.updateChatTelemetry(asst, { error: ev.error, finishReason: 'error' })
          } else if (ev.type === 'approval_needed') {
            this.chatApproval(ev)
          } else if (ev.type === 'event' && ev.event?.type === 'approval_needed') {
            this.chatApproval(ev.event)
          } else if (ev.type === 'event' && ev.event?.type === 'tool_call') {
            asst.events.push(`⚙ ${ev.event.name ?? 'tool'}`)
            // Don't reload on tool_call — file may not be fully written yet.
          } else if (ev.type === 'event' && ev.event?.type === 'tool_result') {
            asst.events.push(`${ev.event.ok === false ? '⚠' : '✓'} ${ev.event.name ?? 'tool'}`)
            if (ev.event.ok !== false) this.maybeReloadStageFromToolEvent(ev.event)
          } else if (ev.type === 'event' && ['gen_info', 'usage'].includes(ev.event?.type)) {
            this.updateChatTelemetry(asst, ev.event)
          } else if (ev.type === 'stages_updated') {
            // Authoritative list from server for this turn.
            for (const slug of (ev.slugs ?? [])) this.scheduleStageViewReload(slug)
          } else if (ev.type === 'done') {
            if (!asst.body) asst.body = ev.text ?? ''
            this.chat.tokensUsed = Number(ev.prompt_tokens ?? this.chat.tokensUsed)
            this.updateChatTelemetry(asst, ev.gen_info ?? { finishReason: this.chat.stopRequested ? 'stop' : 'stop' })
            // Do not reload on done — tool_result + stages_updated already scheduled
            // a debounced reload. Extra done reloads caused redraw storms.
          }
          // Throttle stream redraws — full M.redraw of the grid every NDJSON line is expensive.
          this.scheduleChatStreamRedraw()
          const el = document.querySelector('.chat .messages'); if (el) el.scrollTop = el.scrollHeight
        }
      }
    } catch (e) {
      asst.body += `\n⚠ ${e.message}`
      this.updateChatTelemetry(asst, { error: e.message, finishReason: 'error' })
    } finally {
      this.updateChatTelemetry(asst, { finishReason: asst.telemetry?.finishReason ?? (this.chat.stopRequested ? 'stop' : 'stop') })
      this.stopChatClock()
      this.chat.busy = false
      this.chat.stopRequested = false
      this.speakChatMessage(asst)
      M.redraw()
    }
  },
  // ~24fps while Angela streams (full grid redraw is expensive).
  scheduleChatStreamRedraw() {
    const minGap = 1000 / 24
    const now = performance.now()
    if (this._chatStreamRedrawPending) return
    const wait = Math.max(0, minGap - (now - (this._chatStreamRedrawAt ?? 0)))
    this._chatStreamRedrawPending = true
    const fire = () => {
      this._chatStreamRedrawPending = false
      this._chatStreamRedrawAt = performance.now()
      M.redraw()
    }
    if (wait === 0) requestAnimationFrame(fire)
    else setTimeout(() => requestAnimationFrame(fire), wait)
  },
  // Extract stage slug from a chat tool event (file_io__write_file path).
  stageSlugFromToolPath(p) {
    if (!p) return null
    const s = String(p).replace(/\\/g, '/')
    const m = s.match(/(?:^|\/)(?:\.sheets\/)?stages\/([\w-]+)\.coffee$/i)
    return m?.[1] ?? null
  },
  maybeReloadStageFromToolEvent(ev) {
    if (!ev) return
    const name = String(ev.name ?? ev.tool ?? '')
    if (!/write_file/i.test(name)) return
    const args = ev.args ?? ev.input ?? {}
    const slug = this.stageSlugFromToolPath(args.path ?? args.file ?? args.filepath ?? args.file_path)
      || this.stageSlugFromToolPath(String(ev.text ?? '').match(/(?:\.sheets\/)?stages\/[\w-]+\.coffee/)?.[0])
    if (slug) this.scheduleStageViewReload(slug)
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
        <span class="dot" :class="desynced ? 'desync' : (wsConnected ? 'on' : (wsConnecting ? 'connecting' : ''))" :title="desynced ? 'desynchronized: reload persistent files before saving' : (wsConnected ? 'connected to sheets server' : (wsConnecting ? 'connecting to sheets server' : 'disconnected from sheets server'))" x-text="desynced ? '!' : ''"></span><span class="desync-label" x-show="desynced">desync</span><span class="title">sheets</span>
        <span x-text="meta ? meta.root.split('/').pop() : ''" style="color:var(--dim)"></span>
        <div class="dropdown" @click.outside="fieldMenu = false">
          <button class="toolbar-icon-btn toolbar-dropdown-btn" @click="toggleFieldMenu()" title="columns">
            <i class="ph-bold ph-table" aria-hidden="true"></i>
            <i class="ph-fill ph-caret-down toolbar-dropdown-caret" aria-hidden="true"></i>
          </button>
          <div class="menu" x-show="fieldMenu">
            <div class="column-picker-filter" :class="columnPickerFilter ? 'has-clear' : ''">
              <i class="ph-bold ph-funnel" aria-hidden="true"></i>
              <input id="sheets-column-picker-filter" type="search" placeholder="filter columns…" spellcheck="false"
                :value="columnPickerFilter" @input="setColumnPickerFilter($event.target.value)"
                @keydown="if ($event.key === 'Escape') { $event.preventDefault(); setColumnPickerFilter('') }">
              <button type="button" class="field-clear" x-show="columnPickerFilter" @click="setColumnPickerFilter('')" title="clear column filter">
                <i class="ph-bold ph-x" aria-hidden="true"></i>
              </button>
            </div>
            <div class="column-group-heading">
              <span>Stages <small x-text="filteredStages.length"></small></span>
              <span class="column-group-bulk">
                <button type="button" class="bulk-link" @click.stop="setStageColumnsVisible(true)" title="show all stages">all</button>
                <button type="button" class="bulk-link" @click.stop="setStageColumnsVisible(false)" title="hide all stages">none</button>
              </span>
            </div>
            <div class="stage-toggle" x-for="stage in filteredStages" :key="stage.slug">
              <label class="col-menu-main">
                <input type="checkbox" :checked="hasStageColumn(stage.slug)" @change="toggleStageColumn(stage.slug)">
                <span class="col-menu-label" x-text="stage.title"></span>
              </label>
              <span class="col-menu-actions">
                <button type="button" class="col-menu-btn danger" title="delete stage from disk"
                  @click.stop="deleteStageFile(stage)">
                  <i class="ph-bold ph-trash" aria-hidden="true"></i>
                </button>
              </span>
            </div>
            <div class="column-group-heading">
              <span>Component fields <small x-text="filteredFieldCount"></small></span>
              <span class="column-group-bulk">
                <button type="button" class="bulk-link" @click.stop="setFieldColumnsVisible(true)" title="show all fields">all</button>
                <button type="button" class="bulk-link" @click.stop="setFieldColumnsVisible(false)" title="hide all fields">none</button>
              </span>
            </div>
            <div class="component-group" x-for="group in filteredFieldTree" :key="group.component">
              <label class="component-toggle">
                <input type="checkbox" :checked="componentChecked(group)" @change="toggleComponent(group)">
                <span x-text="group.component"></span>
              </label>
              <div class="field-toggle" x-for="field in group.fields" :key="field.path">
                <label class="col-menu-main">
                  <input type="checkbox" :checked="hasFieldColumn(field.path)"
                    @change="toggleFieldPath(field.path)">
                  <span class="col-menu-label" :class="field.inSchema ? 'in-schema' : 'undeclared'" x-text="field.name"></span>
                </label>
                <span class="col-menu-actions">
                  <button type="button" class="col-menu-btn" :class="field.inSchema ? 'on' : ''"
                    :title="field.inSchema ? 'remove from schema.yaml' : 'add to schema.yaml'"
                    @click.stop="toggleSchemaField(field)">
                    <i class="ph-bold" :class="field.inSchema ? 'ph-check-square' : 'ph-square'" aria-hidden="true"></i>
                  </button>
                  <button type="button" class="col-menu-btn danger" title="delete field from all entities"
                    @click.stop="deleteFieldEverywhere(field)">
                    <i class="ph-bold ph-trash" aria-hidden="true"></i>
                  </button>
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="toolbar-group" title="columns">
          <span class="toolbar-group-label" aria-hidden="true"><i class="ph-bold ph-columns"></i></span>
          <button class="toolbar-icon-btn" @click="insertColumn()" title="insert stage column after cursor">
            <i class="ph-bold ph-plus-circle" aria-hidden="true"></i>
          </button>
          <button class="toolbar-icon-btn" @click="deleteColumn()" title="delete column at cursor">
            <i class="ph-bold ph-minus-circle" aria-hidden="true"></i>
          </button>
        </div>
        <div class="toolbar-group" title="rows">
          <span class="toolbar-group-label" aria-hidden="true"><i class="ph-bold ph-rows"></i></span>
          <button class="toolbar-icon-btn" @click="addRow()" title="create a new entity YAML row">
            <i class="ph-bold ph-plus-circle" aria-hidden="true"></i>
          </button>
          <button class="toolbar-icon-btn" @click="deleteRows()" title="delete rows included in the selection">
            <i class="ph-bold ph-minus-circle" aria-hidden="true"></i>
          </button>
          <button class="toolbar-icon-btn" @click="duplicateRows()" title="Duplicate row"
            :disabled="!hasRowSelection">
            <i class="ph-bold ph-copy" aria-hidden="true"></i>
          </button>
        </div>
        <div class="search-wrap" :class="(searchDraft ? 'on ' : '') + (searchDraft ? 'has-clear' : '')"
          title="search entities (regex over all field values)">
          <i class="ph-bold ph-magnifying-glass search-icon" aria-hidden="true"></i>
          <input class="search-input" id="sheets-search-input" type="text" placeholder="search…" spellcheck="false"
            :value="searchDraft"
            @input="onSearchInput($event.target.value)"
            @keydown="if ($event.key === 'Escape') { $event.preventDefault(); clearSearch() }
              else if ($event.key === 'Enter') { $event.preventDefault(); applySearchDraft(searchDraft, { immediate: true }) }">
          <button type="button" class="field-clear" x-show="searchDraft" @click="clearSearch()" title="clear search">
            <i class="ph-bold ph-x" aria-hidden="true"></i>
          </button>
        </div>
        <div class="page-controls" title="spreadsheet row pagination">
          <button class="toolbar-icon-btn" @click="setPage(page - 1)" :disabled="page <= 0" title="previous page"><i class="ph-bold ph-caret-left" aria-hidden="true"></i></button>
          <label class="page-number" title="type a page number">
            <input id="sheets-page-jump" type="text" inputmode="numeric" pattern="[0-9]*" :value="page + 1"
              @change="jumpToPage($event.target.value)"
              @keydown="if ($event.key === 'Enter') { $event.preventDefault(); jumpToPage($event.target.value); $event.target.blur() }">
            <span x-text="'/ ' + pageCount"></span>
          </label>
          <button class="toolbar-icon-btn" @click="setPage(page + 1)" :disabled="page >= pageCount - 1" title="next page"><i class="ph-bold ph-caret-right" aria-hidden="true"></i></button>
          <select class="page-size" :value="pageSize" @change="setPageSize($event.target.value)" title="rows per page">
            <option value="5">5</option><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option>
          </select>
        </div>
        <span class="refresh-monitor" :title="'MJS refresh requests: ' + refreshCount + ' · throttled: ' + throttledRefreshCount" x-text="'refresh ' + refreshCount"></span>
        <div class="toolbar-end">
          <span class="play-summary" x-text="playSummaryLabel"></span>
          <button class="toolbar-icon-btn play-btn" @click="play()" title="run selection (Ctrl/Cmd+G)">
            <i class="ph-bold ph-play" aria-hidden="true"></i>
          </button>
        </div>
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
      <div class="gridwrap" x-show="!focus" @scroll="onScroll($event)" @mouseup="cellUp()" @mousedown="gridVoidDown($event)">
        <table class="grid" :class="(colResize ? 'col-resizing ' : '') + (rowResize ? 'row-resizing' : '')">
          <thead>
            <tr>
              <th class="corner rowhead">
                <div class="corner-sel">
                  <span class="sel-readout" x-text="selReadout"></span>
                  <button class="sel-copy" type="button" :class="selReadout ? 'has-text' : ''"
                    @click.stop="copySelReadout()" title="copy selection range">
                    <i class="ph-bold ph-copy" aria-hidden="true"></i>
                  </button>
                </div>
              </th>
              <th class="colhead col-resizable" x-for="col, ci in columns" :key="col.stage || col.field || 'empty-' + ci" :class="colSelected(ci) ? 'selected-head' : ''" :style="colStyle(ci)" @click="colHeadClick(ci, $event)"
                :title="'click: select column · alt-click: sort · drag edge: resize'">
                <span class="letter" x-text="colLetter(ci)"></span>
                <span x-text="sort && sort.ci === ci ? (sort.dir === 'asc' ? '↑' : '↓') : ''"></span>
                <div class="col-resize" :class="colResize && colResize.ci === ci ? 'active' : ''" title="drag to resize column" @pointerdown="startColResize(ci, $event)"></div>
              </th>
            </tr>
            <tr class="magic">
              <th class="rowhead"></th>
              <th class="col-resizable" x-for="col, ci in columns" :key="col.stage || col.field || 'empty-' + ci"
                :class="(columnHasFilter(ci) || (sort && sort.ci === ci) ? 'col-filtered ' : '') + (filterMenu && filterMenu.ci === ci ? 'filter-open' : '')"
                :style="colStyle(ci)">
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
                    <div class="magic-prompt">
                      <input class="magic-prompt-input" type="text" placeholder="describe this stage…"
                        :value="magicInput[ci] || ''" @input="magicInput[ci] = $event.target.value"
                        @keydown="magicPromptKey(ci, $event)">
                      <button type="button" class="angela-send" @click.stop="magicSubmit(ci)" title="send to Angela">✨</button>
                    </div>
                  </template>
                  <span class="actions">
                    <button class="col-move" title="move column left" x-show="ci > 0" @click.stop="moveColumn(ci, -1)">‹</button>
                    <button class="col-move" title="move column right" x-show="ci < columns.length - 1" @click.stop="moveColumn(ci, 1)">›</button>
                    <button class="filter-btn"
                      :class="(columnHasFilter(ci) || (sort && sort.ci === ci) ? 'on ' : '') + (columnHasFilter(ci) || (sort && sort.ci === ci) || (filterMenu && filterMenu.ci === ci) ? 'force-show' : '')"
                      title="sort / filter column" @click.stop="openFilterMenu(ci, $event)">
                      <i class="ph-bold ph-funnel" aria-hidden="true"></i>
                    </button>
                  </span>
                  <div class="col-filter-menu" x-show="filterMenu && filterMenu.ci === ci" @click.stop>
                    <div class="cfm-row sort-row">
                      <span class="cfm-label"><i class="ph-bold ph-arrows-down-up" aria-hidden="true"></i>Sort:</span>
                      <button type="button" class="cfm-sort" :class="sort && sort.ci === ci && sort.dir === 'asc' ? 'on' : ''"
                        @click.stop="setSort(ci, 'asc')" title="sort ascending">
                        <i class="ph-bold ph-sort-ascending" aria-hidden="true"></i>
                      </button>
                      <button type="button" class="cfm-sort" :class="sort && sort.ci === ci && sort.dir === 'desc' ? 'on' : ''"
                        @click.stop="setSort(ci, 'desc')" title="sort descending">
                        <i class="ph-bold ph-sort-descending" aria-hidden="true"></i>
                      </button>
                      <button type="button" class="cfm-clear" x-show="sort && sort.ci === ci" @click.stop="clearSort(ci)" title="clear sort">×</button>
                    </div>
                    <div class="cfm-label cfm-filter-label">
                      <i class="ph-bold ph-funnel" aria-hidden="true"></i><span>Filter by value:</span>
                      <button type="button" class="cfm-not" :class="colFilterNot && colFilterNot[ci] ? 'on' : ''"
                        :aria-pressed="colFilterNot && colFilterNot[ci] ? 'true' : 'false'"
                        @click.stop="toggleFilterNot(ci)"
                        :title="colFilterNot && colFilterNot[ci] ? 'inverted — showing rows that do NOT match' : 'invert filter — show rows that do NOT match'">NOT</button>
                    </div>
                    <div class="cfm-filter-row" :class="filterDraft ? 'has-clear' : ''">
                      <input class="filter-re" type="text" placeholder="regex…" spellcheck="false"
                        :id="'sheets-col-filter-' + ci"
                        :value="filterMenu && filterMenu.ci === ci ? filterDraft : ''"
                        @input="onFilterDraftInput(ci, $event.target.value)"
                        @keydown="if ($event.key === 'Escape') { $event.preventDefault(); closeFilterMenu() }
                          else if ($event.key === 'Enter') { $event.preventDefault(); applyFilterDraft(ci, filterDraft, { immediate: true }) }">
                      <button type="button" class="field-clear" x-show="filterDraft"
                        @click.stop="clearFilterInput(ci)" title="clear filter">
                        <i class="ph-bold ph-x" aria-hidden="true"></i>
                      </button>
                    </div>
                    <div class="cfm-values" x-show="filterMenu && filterMenu.ci === ci">
                      <div class="cfm-label"><i class="ph-bold ph-list-numbers" aria-hidden="true"></i>Top values</div>
                      <div class="cfm-values-empty" x-show="filterValues.loading">counting…</div>
                      <div class="cfm-values-empty" x-show="!filterValues.loading && !filterValues.items.length">no values</div>
                      <label class="cfm-value" x-for="v, vi in filterValues.items" :key="v.value" @click.stop>
                        <input type="checkbox" :checked="isValuePicked(ci, v.value)"
                          @change.stop="toggleValuePick(ci, v.value)">
                        <span class="cfm-value-main">
                          <span class="cfm-value-row">
                            <span class="cfm-value-text" :title="v.value" x-text="v.value"></span>
                            <span class="cfm-value-pct" x-text="valuePct(v) + '%'"></span>
                          </span>
                          <span class="cfm-value-bar"><span :style="'width:' + valuePct(v) + '%'"></span></span>
                        </span>
                      </label>
                      <div class="cfm-value other" x-show="!filterValues.loading && filterValues.items.length">
                        <span class="cfm-value-main">
                          <span class="cfm-value-row">
                            <span class="cfm-value-text">Other</span>
                            <span class="cfm-value-pct" x-text="filterValuesOtherPct + '%'"></span>
                          </span>
                          <span class="cfm-value-bar"><span :style="'width:' + filterValuesOtherPct + '%'"></span></span>
                        </span>
                      </div>
                      <div class="cfm-values-note" x-show="!filterValues.loading && filterValues.items.length"
                        x-text="filterValues.distinct + ' distinct across ' + filterValues.sampled + ' rows'"></div>
                    </div>
                  </div>
                </div>
                <div class="col-resize" :class="colResize && colResize.ci === ci ? 'active' : ''" title="drag to resize column" @pointerdown="startColResize(ci, $event)"></div>
              </th>
            </tr>
          </thead>
          <tbody class="virtual-body" :class="rowHeightMode" :style="'transform:' + bodyTransform">
            <!-- Spacers for virtual windows; full-load natural mode keeps pads at 0. -->
            <tr class="virtual-spacer virtual-spacer-top" aria-hidden="true">
              <td :colspan="columns.length + 1">
                <div class="virtual-spacer-fill" :style="'height:' + topPad + 'px'"></div>
              </td>
            </tr>
            <tr class="virtual-row" x-for="row, i in rows" :key="row.id" :data-row-id="row.id" :class="rowClass(row)" :style="rowStyle(row)">
              <td class="rowhead" :class="rowSelected(i) ? 'selected-head' : ''" @click="rowHeadClick(i, $event)">
                <span class="rownum" x-text="winStart + i + 1"></span>
                <span class="row-main">
                  <input class="row-rename-input" x-show="renaming && renaming.id === row.id" x-model="renaming.value"
                    @keydown="renameKey($event)" @blur="commitRename()" :title="row.file || row.id">
                  <span class="rowlabel" x-show="!renaming || renaming.id !== row.id" x-text="row.label" :title="row.file || row.id"
                    @click.stop="startRename(i)"></span>
                  <button class="row-copy" type="button" x-show="row.id" @click.stop="copyEntityPath(row)"
                    :title="'copy path: ' + (row.file || row.id)">
                    <i class="ph-bold ph-copy" aria-hidden="true"></i>
                  </button>
                  <button class="row-collapse" type="button" x-show="row.id" @click.stop="toggleRowCollapsed(row)"
                    :title="isRowCollapsed(row) ? 'expand row' : 'collapse row'">
                    <i :class="isRowCollapsed(row) ? 'ph-bold ph-caret-down' : 'ph-bold ph-caret-up'" aria-hidden="true"></i>
                  </button>
                </span>
                <div class="row-resize" :class="rowResize && rowResize.id === row.id ? 'active' : ''"
                  title="drag to resize row" @pointerdown="startRowResize(i, $event)"></div>
              </td>
              <td x-for="col, ci in columns" :key="col.stage || col.field || 'empty-' + ci" :data-r="i" :data-c="ci" :style="colStyle(ci)"
                :class="(inSel(i, ci) ? 'sel ' : '') + (isActive(i, ci) ? 'active ' : '') + cellStateClass(row, ci) + (isStageEditorCell(row, ci) ? 'stage-editor-cell ' : '')"
                @mousedown="cellDown(i, ci, $event)" @mouseover="cellOver(i, ci, $event)"
                @dblclick="cellDbl(i, ci)">
                <template x-if="isStageEditorCell(row, ci)"><div x-mount="stageEditor && stageEditor.component"></div></template>
                <template x-if="!isStageEditorCell(row, ci)"><div class="cell-inner" x-html="cellHtml(row, ci)"></div></template>
              </td>
            </tr>
            <tr class="virtual-spacer virtual-spacer-bot" aria-hidden="true">
              <td :colspan="columns.length + 1">
                <div class="virtual-spacer-fill" :style="'height:' + bottomPad + 'px'"></div>
              </td>
            </tr>
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
            <button class="tab-menu" title="activity options" @click.stop="toggleTabMenu(a.slug)">
              <i class="ph-fill ph-caret-down" aria-hidden="true"></i>
            </button>
            <div class="tab-context" x-show="tabMenu === a.slug">
              <button @click.stop="deleteTab(a.slug)">delete</button>
            </div>
          </div>
          <div class="tab add-tab" title="add activity" @click="addTab()">
            <i class="ph-bold ph-plus" aria-hidden="true"></i>
          </div>
        </div>
      </div>

    <div class="sidebar" :class="resizing ? 'resizing' : ''" :style="sidebarStyle()">
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
          <button class="queue-clear" x-show="q.queued + q.idle + q.running + q.done + q.error > 0"
            @click="clearQueue()" title="clear queue">
            <i class="ph-bold ph-trash" aria-hidden="true"></i>
          </button>
          <span x-show="q.running > 0 || q.error > 0" x-text="(q.running > 0 ? 'run:' + q.running : '') + (q.running > 0 && q.error > 0 ? ' ' : '') + (q.error > 0 ? 'err:' + q.error : '')"></span>
          <span class="conc-label" style="margin-left:auto" title="concurrency">
            <i class="ph-bold ph-chat-teardrop-dots" aria-hidden="true"></i>
          </span>
          <button class="queue-pause" x-show="q.running > 0" @click="pauseQueue()" title="pause queue">Ⅱ</button>
          <button class="queue-concurrency-step" type="button" @click="setConcurrency(conc - 1)" :disabled="conc <= 0" title="decrease concurrency">
            <i class="ph-bold ph-minus-circle" aria-hidden="true"></i>
          </button>
          <div class="slider" title="concurrency" @pointerdown="sliderDown($event)">
            <div class="fill" :style="'width:' + Math.max(2, conc / 64 * 100) + '%'"></div>
            <div class="val" x-text="conc"></div>
          </div>
          <button class="queue-concurrency-step" type="button" @click="setConcurrency(conc + 1)" :disabled="conc >= 64" title="increase concurrency">
            <i class="ph-bold ph-plus-circle" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="loghead">
        <span class="loghead-label">log</span>
        <div class="log-filter-wrap" :class="(logFilterDraft || logFilterRe ? 'on ' : '') + (logFilterDraft ? 'has-clear' : '')"
          title="filter log lines by regular expression">
          <i class="ph-bold ph-funnel log-filter-icon" aria-hidden="true"></i>
          <input class="log-filter" id="sheets-log-filter-input" type="text" placeholder="filter…" spellcheck="false"
            :value="logFilterDraft"
            @input="onLogFilterInput($event.target.value)"
            @keydown="if ($event.key === 'Escape') { $event.preventDefault(); clearLogFilter() }
              else if ($event.key === 'Enter') { $event.preventDefault(); applyLogFilter(logFilterDraft, { immediate: true }) }">
          <button type="button" class="field-clear" x-show="logFilterDraft" @click="clearLogFilter()" title="clear log filter">
            <i class="ph-bold ph-x" aria-hidden="true"></i>
          </button>
        </div>
        <button class="log-wrap-btn" :class="logWrap ? 'on' : ''" @click="toggleLogWrap()"
          :title="logWrap ? 'disable word wrap' : 'enable word wrap'">
          <i class="ph-bold ph-paragraph" aria-hidden="true"></i>
        </button>
      </div>
      <div class="logbox" :class="logWrap ? 'wrap' : ''" :style="logStyle()" @scroll="logScroll($event)" @wheel="logWheel($event)">
        <div class="logline" x-for="ev, i in visibleLogs" :key="i" x-html="logHtml(ev)"></div>
      </div>
      <div class="sidebar-resize-h" title="resize log and chat" @pointerdown="startChatResize($event)"></div>
      <div class="chat">
        <div class="chat-header">
          <span class="chat-title">angela</span>
          <span class="chat-elapsed" x-show="chat.elapsed" x-text="chat.elapsed"></span>
          <button class="chat-speaker" :class="chat.speak ? 'on' : ''" @click="toggleChatSpeak()" :title="chat.speak ? 'disable Ada voice output' : 'enable Ada voice output'"><i class="ph-bold ph-speaker-high" aria-hidden="true"></i></button>
          <button class="chat-stop" x-show="chat.busy" @click="chatStop()" title="stop Angela"><i class="ph-bold ph-stop" aria-hidden="true"></i></button>
        </div>
        <div class="chat-speak-warning" x-show="chat.speakWarning">Ada voice output is unavailable. Check that the <b>ada</b> command is installed.</div>
        <div class="disabled" x-show="!chat.enabled">Angela chat is off — run <b>sheets init</b> in this workspace to scaffold .angela/agents/angela.coffee, then restart the server.</div>
        <div class="messages" x-show="chat.enabled">
          <div class="msg" x-for="m, i in chat.messages" :key="i" :class="(m.who === 'you' ? 'user' : (m.who === 'approval' ? 'approval' : 'assistant')) + (m.visible === false ? ' hidden' : '') + (m.bookmarked ? ' bookmarked' : '')">
            <div class="who" x-text="m.who"></div>
            <div class="ev" x-for="e, j in m.events || []" :key="j" x-text="e"></div>
            <div class="body" x-show="m.who !== 'approval'" x-text="m.body"></div>
            <div class="approval-card" x-show="m.who === 'approval'">
              <div class="approval-title"><i class="ph-bold ph-warning" aria-hidden="true"></i><span>approval required</span></div>
              <div class="approval-name" x-text="m.name"></div>
              <div class="approval-reason" x-text="m.reason"></div>
              <pre class="approval-command" x-show="m.command" x-text="m.command"></pre>
              <div class="approval-actions" x-show="m.status === 'pending'">
                <button class="approval-allow" @click="chatApprove(m, 'allow')">Allow</button>
                <button class="approval-deny" @click="chatApprove(m, 'deny')">Deny</button>
              </div>
              <div class="approval-status" x-show="m.status !== 'pending'" x-text="m.status"></div>
            </div>
            <div class="msg-gutter">
              <div class="gutter-actions">
                <button class="gutter-btn" @click="toggleChatMessageVisible(m)" :title="m.visible === false ? 'include message in context' : 'exclude message from context'"><i class="ph-bold" :class="m.visible === false ? 'ph-eye-slash' : 'ph-eye'" aria-hidden="true"></i></button>
                <button class="gutter-btn" :class="m.bookmarked ? 'on' : ''" @click="toggleChatMessageBookmark(m)" :title="m.bookmarked ? 'remove bookmark' : 'bookmark message'"><i class="ph-bold ph-bookmark-simple" aria-hidden="true"></i></button>
              </div>
              <div class="chat-metrics" x-html="chatTelemetryHtml(m)"></div>
            </div>
          </div>
        </div>
        <div class="composer" x-show="chat.enabled">
          <div class="allowlist-panel" x-show="chat.allowlistOpen">
            <div class="panel-label"><span>allowed tools</span><span x-text="chat.allowlistOverridden ? '· ui override' : '· agent default'"></span></div>
            <textarea class="allowlist-editor" rows="5" :value="chat.allowlist" @input="chatAllowlistInput($event)" @blur="chatAllowlistBlur()" spellcheck="false"></textarea>
            <button class="panel-reset" @click="resetChatAllowlist()">reset to agent default</button>
          </div>
          <div class="tools-panel" x-show="chat.toolsOpen">
            <div class="panel-label"><span>tools for inference</span><span x-text="chat.toolsEnabledOverridden ? '· ui override' : '· agent default'"></span></div>
            <div class="tools-actions"><button @click="enableAllChatTools()">all</button><button @click="disableAllChatTools()">none</button><button @click="resetChatTools()">reset</button></div>
            <div class="tools-loading" x-show="chat.toolsLoading">loading tools…</div>
            <div class="tools-error" x-show="chat.toolsError" x-text="chat.toolsError"></div>
            <label class="tool-row" x-for="tool in chat.tools" :key="tool.name">
              <input type="checkbox" :checked="chatToolChecked(tool)" @change="setChatToolEnabled(tool.name, $event.target.checked)">
              <span x-text="tool.name" :title="tool.description"></span>
            </label>
          </div>
          <textarea class="chat-draft" rows="2" placeholder="Message… (Enter send, Shift+Enter newline; selection context attaches automatically)"
            x-model="chat.input" @keydown="chatKey($event)"></textarea>
          <div class="composer-row">
            <select class="chat-dd agent-dd" :value="chat.agent" @change="chatAgentChange($event)" title="agent">
              <option x-for="agent in chat.agents" :key="agent.name" :value="agent.name" x-text="agent.name"></option>
            </select>
            <select class="chat-dd model-dd" :value="chat.model" @change="chatModelChange($event)" title="model">
              <option x-for="model in chat.models" :key="model" :value="model" x-text="model"></option>
            </select>
            <select class="chat-dd effort-dd" :value="chat.reasoningEffort" @change="chatEffortChange($event)" title="reasoning effort">
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option>
            </select>
            <button class="chat-icon-btn" x-show="chatModelSupportsThinking" :class="chat.thinking ? 'on' : ''" @click="toggleChatThinking()" title="toggle model thinking"><i class="ph-bold ph-brain" aria-hidden="true"></i></button>
            <div class="context-meter" :style="'--context-pct:' + chatContextPct() + '%'" :title="chatContextTitle()"><span x-text="chatContextLabel()"></span></div>
            <button class="chat-icon-btn" :class="chat.toolsOpen ? 'on' : ''" @click="toggleChatTools()" title="tools for inference"><i class="ph-bold ph-wrench" aria-hidden="true"></i></button>
            <button class="chat-icon-btn" :class="chat.allowlistOpen ? 'on' : ''" @click="toggleChatAllowlist()" title="allowlist"><i class="ph-bold ph-shield-check" aria-hidden="true"></i></button>
            <button class="chat-send chat-stop-inline" x-show="chat.busy" @click="chatStop()" title="stop Angela"><i class="ph-bold ph-stop" aria-hidden="true"></i></button>
            <button class="chat-send primary" x-show="!chat.busy" @click="chatSend()" :disabled="!chat.input.trim()" title="send message"><i class="ph-bold ph-paper-plane-right" aria-hidden="true"></i></button>
          </div>
        </div>
      </div>
      <div class="sidebar-resize-w" title="resize sidebar" @pointerdown="startSidebarWidthResize($event)"></div>
    </div>
  </div>
  <div class="toast" x-show="toast" x-text="toast"></div>
  <div class="overlay-edit" x-show="editing" :style="editing ? 'position:fixed;z-index:60;left:' + editing.x + 'px;top:' + editing.y + 'px;width:' + editing.w + 'px' : ''">
    <input x-model="editing.value" @keydown="editKey($event)" @blur="commitEdit()" style="width:100%">
  </div>
  `,
  colLetter,
  }
}

function patchApp(existing, next) {
  if (!existing || !next) return existing
  const descs = Object.getOwnPropertyDescriptors(next)
  for (const [key, desc] of Object.entries(descs)) {
    if (key === 'init') continue // keep first-boot listeners / WS
    if (desc.get || desc.set) {
      Object.defineProperty(existing, key, desc)
    } else if (typeof desc.value === 'function') {
      existing[key] = desc.value
    } else if (key === 'template') {
      existing.template = desc.value
    } else if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      existing[key] = desc.value
    }
  }
  return existing
}

function bindGlobalPlayShortcut() {
  if (window.__SHEETS_SHIFT_F5_HANDLER__) {
    window.removeEventListener('keydown', window.__SHEETS_SHIFT_F5_HANDLER__, true)
    delete window.__SHEETS_SHIFT_F5_HANDLER__
  }
  if (window.__SHEETS_PLAY_SHORTCUT_HANDLER__) {
    window.removeEventListener('keydown', window.__SHEETS_PLAY_SHORTCUT_HANDLER__, true)
  }
  const handler = (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
    if (event.key.toLowerCase() !== 'g') return
    event.preventDefault()
    event.stopImmediatePropagation()
    void M.root?.play()
  }
  window.__SHEETS_PLAY_SHORTCUT_HANDLER__ = handler
  window.addEventListener('keydown', handler, true)
}

async function boot(bust = 0) {
  const next = createApp()
  if (!window.__SHEETS_MOUNTED__) {
    window.__SHEETS_MOUNTED__ = true
    M.mount('#app', () => next)
    bindGlobalPlayShortcut()
    console.info('[sheets] mounted')
    return
  }
  const root = M.root
  if (!root) {
    M.mount('#app', () => next)
    bindGlobalPlayShortcut()
    console.info('[sheets] remounted', bust)
    return
  }
  patchApp(root, next)
  bindGlobalPlayShortcut()
  if (bust) {
    // A lib-only HMR update leaves the stage Coffee source hash unchanged.
    // Drop browser view-module caches so recycled virtual rows cannot mix old
    // and new renderers after a views.mjs edit.
    root.viewMods = {}
    root.viewLoading = {}
    root._viewPromises = {}
    root._viewSourceHash = {}
    root._forceNextViewRedraw = true
  }
  M.redraw({ force: bust !== 0 })
  console.info('[sheets] hot reloaded', bust)
}

window.__M_BOOT__ = boot
// First load boots here; HMR re-imports set __M_BOOT__ then hot-client calls it.
if (!window.__SHEETS_HMR_BOOTSTRAPPED__) {
  window.__SHEETS_HMR_BOOTSTRAPPED__ = true
  await boot(0)
}
