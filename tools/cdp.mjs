#!/usr/bin/env node
// Inspect the running dev build over Chrome DevTools, without macOS
// accessibility queries (Electron 18 crashes on those under macOS 26).
//
// Start the app with:  npx electron . <project.storyboarder> --remote-debugging-port=9223
//
//   node tools/cdp.mjs list
//   node tools/cdp.mjs shot <url-substring> <out.png>
//   node tools/cdp.mjs eval <url-substring> "<js expression>"

const PORT = process.env.CDP_PORT || 9223
const [cmd, match, arg] = process.argv.slice(2)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()

if (cmd === 'list' || !cmd) {
  for (const t of targets) console.log(`${t.type}\t${t.title}\t${t.url}`)
  process.exit(0)
}

const target = targets.find(t => t.type === 'page' && t.url.includes(match))
if (!target) {
  console.error(`No page whose URL contains "${match}"`)
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = e => {
  const msg = JSON.parse(e.data)
  if (pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) => new Promise(resolve => {
  const n = ++id
  pending.set(n, resolve)
  ws.send(JSON.stringify({ id: n, method, params }))
})
await new Promise(r => (ws.onopen = r))

if (cmd === 'shot') {
  const { writeFile } = await import('node:fs/promises')
  const res = await send('Page.captureScreenshot', { format: 'png' })
  if (!res.result) { console.error(res.error); process.exit(1) }
  await writeFile(arg, Buffer.from(res.result.data, 'base64'))
  console.log(arg)
} else if (cmd === 'eval') {
  const res = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  const r = res.result
  if (r?.exceptionDetails) {
    console.error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    process.exit(1)
  }
  console.log(JSON.stringify(r?.result?.value, null, 2))
}
ws.close()
