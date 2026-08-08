export meta =
  title: 'Eating noise'
  prompt: 'Based on the color of the fruit and the animal that eats it , Describe the noise the animal would make while eating the fruit .'
  writes: ['animal.noise']

# Gate: needs fruit name + color (A) + animal (B) before describing the eating noise.
export gate = (entity) ->
  present = (v) -> v? and String(v).trim() isnt ''
  present(entity.produce?.name) and present(entity.appearance?.color) and present(entity.animal?.name)

export clear = (entity) ->
  animal: noise: ''

export reduce = (entity, ctx) ->
  if entity.animal?.noise? and String(entity.animal.noise).trim() isnt ''
    ctx.log "skip #{entity.produce?.name}: animal.noise already set"
    return {}
  agent = await ctx.Agent.factory
    model: ctx.model
    system_prompt: """
      You are an imaginative writer. Based on the animal, the fruit, and the specific color of the fruit, 
      describe the sound/noise the animal makes while eating it. 
      Be vivid and sensory.
      <entity>
      #{ctx.yaml entity}
      </entity>
      """
    output_tool:
      name: 'answer'
      description: 'Return the noise description'
      parameters:
        noise: { type: 'string', description: 'A 1-2 sentence description of the eating noise' }
      required: ['noise']
      fn: (args) ->
        t = String(args.noise ? '').trim()
        throw new Error 'noise must be non-empty' unless t.length > 0
        { noise: t }
    stream: false
    retries: 0
  ctx.onAgent agent
  out = await agent.run prompt: meta.prompt
  animal: noise: out.noise

esc = (s) -> String(s ? '').replace /[&<>"']/g, (c) -> '&#' + c.charCodeAt(0) + ';'

export views =
  cell: (entity) ->
    noise = entity.animal?.noise ? ''
    return template: '<span style="color:#8b8f99">—</span>' unless noise
    # .cell-tall opts this widget into multi-line layout; the grid row grows with content
    template: '<div class="cell-tall noise-cell">' + esc(noise) + '</div>'
