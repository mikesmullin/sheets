export meta =
  title: 'Animal Sleep Pattern'
  prompt: 'when does this animal sleep?'
  writes: ['animal.sleep_pattern']

export gate = (entity) ->
  entity.animal?.name?

export clear = (entity) ->
  animal: sleep_pattern: ''

export reduce = (entity, ctx) ->
  agent = await ctx.Agent.factory
    model: ctx.model
    system_prompt: """
      You are a wildlife expert. Based on the animal provided, describe its typical sleep patterns (e.g., nocturnal, diurnal, hibernation, or specific times of day).
      The response MUST be very short, limited to 1-3 words.
      You must use your output tool to provide the final answer.
      <entity>
      #{ctx.yaml entity}
      </entity>
      """
    output_tool:
      name: 'answer'
      description: 'Return the sleep pattern description'
      parameters:
        sleep_pattern: { type: 'string', description: 'A 1-3 word description of when the animal sleeps' }
      required: ['sleep_pattern']
      fn: (args) ->
        t = String(args.sleep_pattern ? '').trim()
        throw new Error 'sleep_pattern must be non-empty' unless t.length > 0
        { sleep_pattern: t }
    stream: true
    retries: 0
  ctx.onAgent agent
  out = await agent.run prompt: meta.prompt
  animal: sleep_pattern: out.sleep_pattern

esc = (s) -> String(s ? '').replace /[&<>"']/g, (c) -> '&#' + c.charCodeAt(0) + ';'

export views =
  cell: (entity) ->
    sleep = entity.animal?.sleep_pattern ? ''
    return template: '<span style="color:#8b8f99">—</span>' unless sleep
    template: '<div style="white-space: pre-wrap; font-family: inherit; color: green;">' + esc(sleep) + '</div>'
