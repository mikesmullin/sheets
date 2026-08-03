#!/usr/bin/env bun
// sheets CLI shim — explicit register import so .coffee loads regardless of cwd (brain pattern).
import 'bun-coffeescript/register'
const { main } = await import('../src/cli.coffee')
await main(process.argv.slice(2))
