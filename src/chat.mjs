// Angela chat API (§8) — angela loaded as a library (brain viz-chat pattern, slimmed copy).
// POST /api/chat streams NDJSON events (assistant_delta / tool_call / done / error);
// sessions persist in <root>/.angela/sessions/. Every turn carries selection context
// (activity, selected cells, focused stage source) appended inside <sheets-context>.
import fs from 'node:fs'
import path from 'node:path'

let _lib = null
async function lib() {
  if (!_lib) _lib = await import('angela')
  return _lib
}

export function createChatApi(ws, deps) {
  let harness = null
  let session = null
  let sink = null // active NDJSON writer for the in-flight run
  let agentDef = null
  let activeModel = null
  let approvalQueue = null
  let allowlistState = { text: '', baseline: '', overridden: false, initialized: false }
  let toolsState = { enabled: null, baseline: null, overridden: false, initialized: false }
  let thinking = false
  let reasoningEffort = 'medium'

  const send = (obj) => { try { sink?.(obj) } catch {} }

  async function loadDefinition(agentName = 'angela') {
    const { loadAgent } = await lib()
    try {
      return await loadAgent(agentName, { projectRoot: ws.root })
    } catch (err) {
      // Silent empty fallbacks made Angela look "mock": no system prompt, no file-io tools.
      console.error(`sheets chat: failed to load agent "${agentName}":`, err?.message ?? err)
      throw new Error(
        `Angela agent "${agentName}" failed to load (${err?.message ?? err}). ` +
        `Coffee agents must use module.exports = (ctx) -> … (not export default). ` +
        `See .angela/agents/${agentName}.coffee`,
      )
    }
  }

  function normalizeTools(value) {
    if (value == null) return null
    if (Array.isArray(value)) return value.map(String).filter(Boolean)
    return String(value).split(/[\n,]/).map((name) => name.trim()).filter(Boolean)
  }

  function applyLiveOptions() {
    if (!harness) return
    if (harness.policy) {
      const text = allowlistState.overridden ? allowlistState.text : String(agentDef?.allowlist ?? '')
      if (typeof harness.policy.setAllowlist === 'function') harness.policy.setAllowlist(text)
      else harness.policy.allowlist = text
    }
    if (typeof harness.setToolsEnabled === 'function') harness.setToolsEnabled(toolsState.overridden ? toolsState.enabled : agentDef?.toolsEnabled ?? null)
    harness.setThink?.(thinking)
    harness.setReasoningEffort?.(reasoningEffort)
  }

  function applyRequestOptions(body) {
    if (body.model) activeModel = String(body.model)
    if (body.reasoning_effort) reasoningEffort = String(body.reasoning_effort)
    if (body.thinking != null) thinking = Boolean(body.thinking)
    if (body.allowlistOverridden === true) {
      allowlistState = { ...allowlistState, text: String(body.allowlist ?? ''), overridden: true, initialized: true }
    } else if (body.allowlistOverridden === false) {
      allowlistState = { ...allowlistState, text: allowlistState.baseline, overridden: false }
    }
    if (body.toolsEnabledOverridden === true) {
      toolsState = { ...toolsState, enabled: normalizeTools(body.toolsEnabled) ?? [], overridden: true, initialized: true }
    } else if (body.toolsEnabledOverridden === false) {
      toolsState = { ...toolsState, enabled: toolsState.baseline, overridden: false }
    }
    applyLiveOptions()
  }

  async function closeHarness() {
    try { await harness?.close?.() } catch {}
    harness = null
    session = null
    approvalQueue = null
    activeModel = null
  }

  async function ensureHarness(agentName, model) {
    if (harness) return harness
    const { Angela, resolveMcpList, ApprovalQueue } = await lib()
    const def = agentDef ?? await loadDefinition(agentName ?? 'angela')
    agentDef = def
    allowlistState = allowlistState.initialized ? allowlistState : {
      text: String(def.allowlist ?? ''), baseline: String(def.allowlist ?? ''), overridden: false, initialized: true,
    }
    toolsState = toolsState.initialized ? toolsState : {
      enabled: def.toolsEnabled ?? null, baseline: def.toolsEnabled ?? null, overridden: false, initialized: true,
    }
    const modelName = model ?? activeModel ?? def.model ?? ws.model ?? process.env.FAV_LOCAL_LLM ?? null
    approvalQueue = new ApprovalQueue()
    approvalQueue.subscribe((request) => send({
      type: 'approval_needed', id: request.id, tool: request.tool, name: request.tool,
      command: request.command, args: request.args, reason: request.reason,
    }))
    let mcp = []
    try {
      mcp = resolveMcpList(def.mcp ?? ['file-io'])
    } catch (e) {
      console.error('sheets chat: mcp presets unavailable:', e.message)
    }
    if (!mcp.length) {
      console.warn('sheets chat: no MCP servers resolved — Angela will not be able to write stage files')
    }
    if (!def.system) {
      console.warn('sheets chat: agent definition has empty system prompt')
    }
    harness = await Angela.create({
      projectRoot: ws.root,
      model: modelName ?? undefined,
      system: def.system,
      mcp,
      allowlist: def.allowlist,
      toolsEnabled: toolsState.overridden ? toolsState.enabled : def.toolsEnabled ?? null,
      // Local single-operator default: open (file writes must not stall on approval).
      policyMode: def.policyMode ?? 'open',
      think: thinking,
      reasoning_effort: reasoningEffort,
      onApproval: approvalQueue.createApprover(),
      onEvent: (ev) => {
        if (!ev || ev.type === 'provider_response') return
        if (ev.type === 'approval_needed') return
        if (ev.type === 'assistant_delta' || ev.type === 'reasoning_delta') send({ type: ev.type, text: ev.text })
        else send({ type: 'event', event: ev })
      },
    })
    activeModel = modelName
    applyLiveOptions()
    return harness
  }

  async function chatConfig() {
    const def = agentDef ?? await loadDefinition()
    agentDef = def
    const models = [...new Set([...(def.models ?? []), def.model, activeModel, ws.model, process.env.FAV_LOCAL_LLM].filter(Boolean))]
    const baseline = String(def.allowlist ?? '')
    if (!allowlistState.initialized) allowlistState = { text: baseline, baseline, overridden: false, initialized: true }
    if (!toolsState.initialized) toolsState = { enabled: def.toolsEnabled ?? null, baseline: def.toolsEnabled ?? null, overridden: false, initialized: true }
    return {
      agent: def.name ?? 'angela',
      agents: [{ name: def.name ?? 'angela', description: def.description ?? '' }],
      model: activeModel ?? def.model ?? ws.model ?? process.env.FAV_LOCAL_LLM ?? '',
      models,
      contextWindow: Number(def.contextWindow ?? 32768),
      allowlist: allowlistState.text,
      allowlistBaseline: allowlistState.baseline,
      allowlistOverridden: allowlistState.overridden,
      toolsEnabled: toolsState.enabled,
      toolsBaseline: toolsState.baseline,
      toolsEnabledOverridden: toolsState.overridden,
      thinking,
      reasoningEffort,
      policyMode: def.policyMode ?? 'open',
    }
  }

  async function persistAllowlist() {
    if (!session?.id || !harness?.sessionStore) return
    try {
      const text = allowlistState.overridden ? allowlistState.text : null
      harness.sessionStore.updateMeta(session.id, {
        allowlistSource: allowlistState.overridden ? 'ui' : 'agent',
        allowlist: text,
      })
    } catch {}
  }

  async function handleTools() {
    const h = await ensureHarness()
    if (!session) session = await h.session.create({ title: 'sheets' })
    const tools = await session.listToolCatalog?.() ?? []
    return Response.json({ tools, toolsEnabled: toolsState.enabled, toolsEnabledSource: toolsState.overridden ? 'ui' : 'agent' })
  }

  async function handleAllowlist(req) {
    const body = await req.json().catch(() => ({}))
    if (body.overridden === false) {
      allowlistState = { ...allowlistState, text: allowlistState.baseline, overridden: false, initialized: true }
    } else {
      allowlistState = { ...allowlistState, text: String(body.allowlist ?? ''), overridden: true, initialized: true }
    }
    applyLiveOptions()
    await persistAllowlist()
    return Response.json({ ok: true, allowlist: allowlistState.text, allowlistSource: allowlistState.overridden ? 'ui' : 'agent', overridden: allowlistState.overridden })
  }

  async function handleToolsEnabled(req) {
    const body = await req.json().catch(() => ({}))
    if (body.overridden === false) toolsState = { ...toolsState, enabled: toolsState.baseline, overridden: false, initialized: true }
    else toolsState = { ...toolsState, enabled: normalizeTools(body.toolsEnabled) ?? [], overridden: true, initialized: true }
    applyLiveOptions()
    return Response.json({ ok: true, toolsEnabled: toolsState.enabled, toolsEnabledSource: toolsState.overridden ? 'ui' : 'agent', overridden: toolsState.overridden })
  }

  async function handleApprove(req) {
    const body = await req.json().catch(() => ({}))
    const id = String(body.id ?? '')
    const decision = String(body.decision ?? 'deny')
    const ok = approvalQueue?.resolve(id, decision) ?? false
    return Response.json({ ok, id, decision })
  }

  function selectionContext(body) {
    const parts = []
    if (body.activity) parts.push(`Active activity (worksheet tab): ${body.activity}`)
    if (body.selection) parts.push(`User's current cell selection: ${JSON.stringify(body.selection)}`)
    if (body.stage) {
      const src = deps.stages.source(body.stage)
      parts.push(`Focused column stage slug: ${body.stage}`)
      parts.push(`Stage file path (write here): .sheets/stages/${body.stage}.coffee`)
      if (src != null) parts.push(`--- current .sheets/stages/${body.stage}.coffee ---\n${src}`)
      else parts.push(`(.sheets/stages/${body.stage}.coffee does not exist yet — you MUST create it with file_io__write_file)`)
    }
    if (body.entitySample) parts.push(`Sample entity (YAML doc) — stages read this shape at Play time:\n${JSON.stringify(body.entitySample, null, 2)}`)
    return parts.length ? `\n\n<sheets-context>\n${parts.join('\n\n')}\n</sheets-context>` : ''
  }

  // Magic-row ✨ / stage-author turns: wrap the human sentence so a small local model
  // cannot wander into "I'll fill the cells for you" chat. The actual user sentence is
  // preserved verbatim inside the block for meta.prompt.
  function authoringPrompt(body, raw) {
    if (!body.stage) return raw
    const slug = body.stage
    const exists = deps.stages.source(slug) != null
    const action = exists ? 'EDIT' : 'CREATE'
    return [
      `${action} the stage module at .sheets/stages/${slug}.coffee using file_io__write_file RIGHT NOW.`,
      '',
      'Rules:',
      '- Do not ask questions. Do not fill spreadsheet cells. Do not invent lookup tables.',
      '- For subjective/descriptive work, reduce() MUST call ctx.Agent (real LLM inference at Play time).',
      '- Preserve the user description verbatim in meta.prompt.',
      '- After writing the file, reply with one short summary line.',
      '',
      'User stage description:',
      '"""',
      raw,
      '"""',
    ].join('\n')
  }

  async function handleChat(req) {
    const body = await req.json()
    const raw = String(body.content ?? '')
    applyRequestOptions(body)
    const prompt = authoringPrompt(body, raw)
    const suffix = selectionContext(body)
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        sink = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'))
        try {
          const h = await ensureHarness(body.agent, body.model)
          if (!session || body.newSession) session = await h.session.create({ title: body.title ?? 'sheets' })
          send({ type: 'session', id: session.id ?? null, agent: agentDef?.name ?? 'angela', model: activeModel, contextWindow: Number(agentDef?.contextWindow ?? 32768) })
          const res = await session.run({ prompt: prompt + suffix })
          const text = typeof res === 'string' ? res : (res?.text ?? res?.content ?? '')
          send({ type: 'done', text, model: activeModel })
        } catch (err) {
          console.error('sheets chat: run failed:', err)
          send({ type: 'error', error: String(err?.message ?? err) })
        } finally {
          sink = null
          try { controller.close() } catch {}
        }
      },
      cancel() { sink = null; try { session?.abort?.() } catch {} },
    })
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
  }

  return {
    enabled() {
      try { return fs.existsSync(path.join(ws.root, '.angela', 'agents', 'angela.coffee')) } catch { return false }
    },
    async handle(req, url) {
      const p = url.pathname
      if (p === '/api/chat' && req.method === 'POST') return handleChat(req)
      if (p === '/api/chat/config' && req.method === 'GET') return Response.json(await chatConfig())
      if (p === '/api/chat/tools' && req.method === 'GET') return handleTools()
      if (p === '/api/chat/tools-enabled' && req.method === 'POST') return handleToolsEnabled(req)
      if (p === '/api/chat/allowlist' && req.method === 'POST') return handleAllowlist(req)
      if (p === '/api/chat/approve' && req.method === 'POST') return handleApprove(req)
      if (p === '/api/chat/abort' && req.method === 'POST') {
        try { session?.abort?.() } catch {}
        return Response.json({ ok: true })
      }
      if (p === '/api/chat/new' && req.method === 'POST') { await closeHarness(); return Response.json({ ok: true }) }
      return null
    },
  }
}
