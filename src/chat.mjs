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

  const send = (obj) => { try { sink?.(obj) } catch {} }

  async function ensureHarness(agentName, model) {
    if (harness) return harness
    const { Angela, loadAgent, resolveMcpList } = await lib()
    let def = {}
    try { def = await loadAgent(agentName ?? 'angela', { projectRoot: ws.root }) } catch { def = {} }
    let mcp = []
    try { mcp = resolveMcpList(def.mcp ?? [], undefined) } catch (e) { console.error('sheets chat: mcp presets unavailable:', e.message) }
    harness = await Angela.create({
      projectRoot: ws.root,
      model: model ?? def.model ?? ws.model ?? undefined,
      system: def.system,
      mcp,
      allowlist: def.allowlist,
      policyMode: def.policyMode ?? 'open', // single-operator local tool (§13)
      onEvent: (ev) => {
        if (!ev || ev.type === 'provider_response') return
        if (ev.type === 'assistant_delta' || ev.type === 'reasoning_delta') send({ type: ev.type, text: ev.text })
        else send({ type: 'event', event: ev })
      },
    })
    return harness
  }

  function selectionContext(body) {
    const parts = []
    if (body.activity) parts.push(`Active activity (worksheet tab): ${body.activity}`)
    if (body.selection) parts.push(`User's current cell selection: ${JSON.stringify(body.selection)}`)
    if (body.stage) {
      const src = deps.stages.source(body.stage)
      parts.push(`Focused column stage slug: ${body.stage}`)
      if (src != null) parts.push(`--- current .sheets/stages/${body.stage}.coffee ---\n${src}`)
      else parts.push(`(.sheets/stages/${body.stage}.coffee does not exist yet — create it)`)
    }
    if (body.entitySample) parts.push(`Sample entity (YAML doc):\n${JSON.stringify(body.entitySample, null, 2)}`)
    return parts.length ? `\n\n<sheets-context>\n${parts.join('\n\n')}\n</sheets-context>` : ''
  }

  async function handleChat(req) {
    const body = await req.json()
    const prompt = String(body.content ?? '')
    const suffix = selectionContext(body)
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        sink = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'))
        try {
          const h = await ensureHarness(body.agent, body.model)
          if (!session || body.newSession) session = await h.session.create({ title: body.title ?? 'sheets' })
          send({ type: 'session', id: session.id ?? null })
          const res = await session.run({ prompt: prompt + suffix })
          const text = typeof res === 'string' ? res : (res?.text ?? res?.content ?? '')
          send({ type: 'done', text })
        } catch (err) {
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
      if (p === '/api/chat/abort' && req.method === 'POST') {
        try { session?.abort?.() } catch {}
        return Response.json({ ok: true })
      }
      if (p === '/api/chat/new' && req.method === 'POST') { session = null; return Response.json({ ok: true }) }
      return null
    },
  }
}
