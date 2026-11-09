#!/usr/bin/env bash
# Drives the Claude prompt panel in a running dev build over DevTools and
# screenshots each result. Start the app with --remote-debugging-port=9223 first.
#
#   tools/try-prompts.sh <out-dir> "first prompt" "second prompt" ...
set -euo pipefail
cd "$(dirname "$0")/.."
out="$1"; shift
mkdir -p "$out"
cdp () { node tools/cdp.mjs "$@"; }

for i in $(seq 1 45); do cdp list 2>/dev/null | grep -q main-window && break; sleep 2; done
if ! cdp list | grep -q "shot-generator.html"; then
  cdp eval main-window "require('electron').ipcRenderer.send('shot-generator:open'); 1" >/dev/null
fi
for i in $(seq 1 30); do
  [ "$(cdp eval shot-generator.html "!!document.querySelector('#prompt-panel')" 2>/dev/null)" = "true" ] && break
  sleep 2
done
sleep 4

n=0
for prompt in "$@"; do
  n=$((n + 1))
  json=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$prompt")
  cdp eval shot-generator.html "(()=>{const el=document.querySelector('#prompt-panel-input'); el.focus(); document.execCommand('insertText', false, $json); setTimeout(()=>document.querySelector('.prompt-panel__build').click(), 200); return 1})()" >/dev/null
  sleep 3
  for i in $(seq 1 60); do
    cdp eval shot-generator.html "[...document.querySelectorAll('.prompt-panel__turn')].pop().className" | grep -q working || break
    sleep 2
  done
  echo "--- $n"
  cdp eval shot-generator.html "[...document.querySelectorAll('.prompt-panel__turn')].pop().innerText"
  sleep 5
  cdp shot shot-generator.html "$out/$n.png"
done
