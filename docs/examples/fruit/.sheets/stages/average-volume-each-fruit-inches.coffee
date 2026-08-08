export meta =
  title: 'Average Volume'
  prompt: 'what is the average volume of each fruit (in inches cubed)'
  writes: ['produce.volume_inches_cubed']

# Gate: only needs the fruit identity. Independent of color/animal/noise.
export gate = (entity) ->
  name = entity.produce?.name
  name? and String(name).trim() isnt ''

export clear = (entity) ->
  produce: volume_inches_cubed: 0

export reduce = (entity, ctx) ->
  v = entity.produce?.volume_inches_cubed
  # 0 is the Delete sentinel — treat as empty so re-Play regenerates (like #000000 for color)
  if v? and v isnt '' and Number.isFinite(Number(v)) and Number(v) isnt 0
    ctx.log "skip #{entity.produce?.name}: volume already set"
    return {}
  agent = await ctx.Agent.factory
    model: ctx.model
    system_prompt: """
      You are an expert botanist and geometric analyst.
      Determine the approximate average volume of the specific fruit mentioned in the entity.
      Return the value in cubic inches.
      Be as accurate as possible based on standard fruit sizes.
      <entity>
      #{ctx.yaml entity}
      </entity>
      """
    output_tool:
      name: 'answer'
      description: 'Return the average volume in cubic inches'
      parameters:
        volume_inches_cubed: { type: 'number', description: 'The average volume in cubic inches' }
      required: ['volume_inches_cubed']
      fn: (args) ->
        t = Number args.volume_inches_cubed
        throw new Error 'volume must be a finite number' unless Number.isFinite t
        { volume_inches_cubed: t }
    stream: true
    retries: 0
  ctx.onAgent agent
  out = await agent.run prompt: meta.prompt
  ctx.log "Fruit: " + entity.produce?.name + " -> Volume: " + out.volume_inches_cubed
  produce:
    volume_inches_cubed: out.volume_inches_cubed

esc = (s) -> String(s ? '').replace /[&<>"']/g, (c) -> '&#' + c.charCodeAt(0) + ';'

export views =
  cell: (entity) ->
    v = entity.produce?.volume_inches_cubed
    return template: '<span style="color:#8b8f99">—</span>' unless v? and Number.isFinite Number(v)
    template: '<span class="num-cell">' + esc(Number(v).toFixed(1)) + ' in³</span>'
