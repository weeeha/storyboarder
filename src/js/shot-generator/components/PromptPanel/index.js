import React, { useState, useRef, useCallback, useEffect } from 'react'
import { connect } from 'react-redux'
import { ipcRenderer } from 'electron'

import { getSerializedState, loadScene, updateObject } from '../../../shared/reducers/shot-generator'
import KeyCommandsSingleton from '../KeyHandler/KeyCommandsSingleton'
import Checkbox from '../Checkbox'
import { specToScene, sceneToSpec, frameCamera, fovToLens } from '../../claude/spec-to-scene'
import { getHeadPositions, waitForHeads } from '../../claude/live-scene'
import defaultPoses from '../../../shared/reducers/shot-generator-presets/poses.json'

const newId = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID().toUpperCase() : String(Date.now() + Math.random()))

const describe = spec => {
  const lines = []
  for (const c of spec.characters || []) lines.push(`${c.name} (${c.model}), pose “${c.pose}”`)
  const props = (spec.objects || []).map(o => o.name)
  if (props.length) lines.push(props.join(', '))
  if ((spec.lights || []).length) lines.push(`${spec.lights.length} light${spec.lights.length > 1 ? 's' : ''}`)
  const cam = spec.camera
  if (cam) {
    const shot = cam.framing ? `${cam.framing.shotSize} on ${cam.framing.subject}${cam.framing.overShoulderOf ? ` over ${cam.framing.overShoulderOf}` : ''}, ` : ''
    lines.push(`Camera: ${shot}${cam.z.toFixed(1)} m high, ${Math.round(cam.lensMm)}mm`)
  }
  return lines
}

const boardContext = board => {
  if (!board) return null
  const parts = []
  if (board.shot) parts.push(`shot ${board.shot}`)
  if (board.action) parts.push(`action: ${board.action}`)
  if (board.dialogue) parts.push(`dialogue: ${board.dialogue}`)
  return parts.length ? parts.join('; ') : null
}

const PromptPanel = ({ board, withState, loadScene, updateObject }) => {
  const [prompt, setPrompt] = useState('')
  const [keepScene, setKeepScene] = useState(true)
  const [turns, setTurns] = useState([])
  const [busy, setBusy] = useState(false)
  const [undoScene, setUndoScene] = useState(null)
  const historyRef = useRef(null)

  // history belongs to one board
  useEffect(() => {
    setTurns([])
    setUndoScene(null)
  }, [board && board.uid])

  useEffect(() => {
    if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight
  }, [turns.length])

  const pauseShortcuts = useCallback(paused => {
    KeyCommandsSingleton.getInstance().isEnabledKeysEvents = !paused
  }, [])

  const build = useCallback(async () => {
    const text = prompt.trim()
    if (!text || busy) return

    let before
    let poses
    let aspect
    withState((dispatch, state) => {
      before = getSerializedState(state)
      poses = (state.presets && state.presets.poses) || defaultPoses
      aspect = state.aspectRatio
    })

    const turnIndex = turns.length
    setTurns(t => [...t, { prompt: text, status: 'working' }])
    setBusy(true)
    setPrompt('')

    try {
      let currentSpec = null
      if (keepScene) {
        currentSpec = sceneToSpec(before, poses)
        const heads = getHeadPositions(currentSpec.characters.map(c => c.id))
        for (const c of currentSpec.characters) {
          const h = heads[c.id]
          if (h) c.head = { x: +h.x.toFixed(2), y: +h.y.toFixed(2), z: +h.z.toFixed(2) }
        }
      }
      const { spec, durationMs } = await ipcRenderer.invoke('claude:build-shot', {
        prompt: text,
        currentSpec,
        boardInfo: boardContext(board)
      })
      const scene = specToScene(spec, { scene: before, poses, newId })
      loadScene(scene)

      // Framing intent: once the posed characters exist, aim from real heads.
      const framing = spec.camera && spec.camera.framing
      if (framing) {
        const ids = Object.values(scene.sceneObjects).filter(o => o.type === 'character').map(o => o.id)
        const heads = await waitForHeads(ids)
        const framed = frameCamera(scene, framing, heads, aspect || undefined)
        if (framed) {
          updateObject(scene.activeCamera, framed)
          spec.camera = { ...spec.camera, z: framed.z, lensMm: fovToLens(framed.fov) }
        }
      }
      setUndoScene(before)
      setTurns(t => t.map((turn, i) => i === turnIndex
        ? { ...turn, status: 'done', summary: spec.summary, lines: describe(spec), seconds: Math.round(durationMs / 1000) }
        : turn))
    } catch (err) {
      const message = String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setTurns(t => t.map((turn, i) => i === turnIndex ? { ...turn, status: 'error', error: message } : turn))
      setPrompt(text)
    } finally {
      setBusy(false)
    }
  }, [prompt, busy, keepScene, turns.length, board, withState, loadScene, updateObject])

  const undo = useCallback(() => {
    if (!undoScene) return
    loadScene(undoScene)
    setUndoScene(null)
    setTurns(t => [...t, { status: 'note', summary: 'Restored the scene from before the last build.' }])
  }, [undoScene, loadScene])

  const onKeyDown = event => {
    // keep Backspace, arrows and letters out of the Shot Generator's shortcuts
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      build()
    }
  }

  return (
    <aside id="prompt-panel" aria-label="Build shots with Claude">
      <h2>Build with Claude</h2>
      <div className="prompt-panel__history" ref={historyRef}>
        {turns.length === 0 && (
          <p className="prompt-panel__empty">
            Describe a shot: who is in it, what they are doing, and the framing. Claude places the characters, props, lights and camera.
          </p>
        )}
        {turns.map((turn, i) => (
          <div className={`prompt-panel__turn prompt-panel__turn--${turn.status}`} key={i}>
            {turn.prompt && <p className="prompt-panel__you">{turn.prompt}</p>}
            {turn.status === 'working' && <p className="prompt-panel__did">Building the shot…</p>}
            {turn.status === 'error' && <p className="prompt-panel__did" role="alert">Not built: {turn.error}</p>}
            {(turn.status === 'done' || turn.status === 'note') && (
              <div className="prompt-panel__did">
                <p>{turn.summary}</p>
                {turn.lines && (
                  <ul>
                    {turn.lines.map((line, j) => <li key={j}>{line}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="prompt-panel__compose">
        <label htmlFor="prompt-panel-input">Describe the shot or the change</label>
        <textarea
          id="prompt-panel-input"
          rows={3}
          value={prompt}
          disabled={busy}
          placeholder="e.g. over-the-shoulder from behind Theo"
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={e => e.stopPropagation()}
          onFocus={() => pauseShortcuts(true)}
          onBlur={() => pauseShortcuts(false)}
        />
        <div className="prompt-panel__row">
          <Checkbox
            label="Keep current scene"
            checked={keepScene}
            onClick={() => setKeepScene(k => !k)}
          />
          <button type="button" className="prompt-panel__build" disabled={busy || !prompt.trim()} onClick={build}>
            {busy ? 'Building…' : 'Build shot'}
          </button>
        </div>
        <div className="prompt-panel__row">
          <button type="button" className="prompt-panel__plain" disabled={!undoScene || busy} onClick={undo}>
            Undo last build
          </button>
        </div>
      </div>
    </aside>
  )
}

const withState = fn => (dispatch, getState) => fn(dispatch, getState())

export default connect(
  state => ({ board: state.board }),
  { withState, loadScene: data => loadScene(data), updateObject: (id, values) => updateObject(id, values) }
)(PromptPanel)
