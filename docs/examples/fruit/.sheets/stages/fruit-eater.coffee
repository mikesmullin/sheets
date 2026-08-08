# Authored by Angela's local fruit-eater template. It is deterministic so the example works
# without requiring a tool-call-capable model provider.
export meta =
  title: 'Fruit eater'
  prompt: "Generate the name of an animal that likes to eat that fruit. Render it as a Wikipedia hyperlink."
  writes: ['animal.name']

# Gate: needs fruit name. Color is independent; noise stage waits on animal.
export gate = (entity) ->
  name = entity.produce?.name
  name? and String(name).trim() isnt ''

animals =
  apple: 'Black bear'
  apricot: 'Ring-tailed lemur'
  banana: 'Capuchin monkey'
  blackberry: 'Red fox'
  blueberry: 'American robin'
  cantaloupe: 'Raccoon'
  cherry: 'Cedar waxwing'
  clementine: 'Orangutan'
  coconut: 'Coconut crab'
  cranberry: 'Wild turkey'
  date: 'Dromedary camel'
  dragonfruit: 'Fruit bat'
  durian: 'Asian elephant'
  fig: 'Fig parrot'
  grape: 'European starling'
  grapefruit: 'Kinkajou'
  guava: 'Green iguana'
  honeydew: 'Brown bear'
  jackfruit: 'Asian elephant'
  kiwi: 'Common brushtail possum'
  lemon: 'Vervet monkey'
  lime: 'Green iguana'
  lychee: 'Flying fox'
  mango: 'Indian flying fox'
  orange: 'Orangutan'
  papaya: 'Toucan'
  peach: 'White-tailed deer'
  pear: 'Black bear'
  pineapple: 'Coati'
  pomegranate: 'House sparrow'
  raspberry: 'Red fox'
  strawberry: 'Eastern cottontail'
  watermelon: 'Striped skunk'

export clear = (entity) ->
  animal: name: ''

export reduce = (entity, ctx) ->
  if entity.animal?.name? and String(entity.animal.name).trim() isnt ''
    ctx.log "skip #{entity.produce.name}: animal.name already set"
    return {}
  fruit = String(entity.produce.name).toLowerCase()
  animal = animals[fruit] ? 'Fruit bat'
  ctx.log fruit + ' → ' + animal
  animal: name: animal

esc = (s) -> String(s ? '').replace /[&<>"']/g, (c) -> '&#' + c.charCodeAt(0) + ';'
wiki = (name) -> 'https://en.wikipedia.org/wiki/' + encodeURIComponent(name.replace /s+/g, '_')

export views =
  cell: (entity) ->
    animal = entity.animal?.name ? ''
    return template: '<span style="color:#8b8f99">—</span>' unless animal
    url = wiki animal
    template: '<a class="animal-link" href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(animal) + '</a>'