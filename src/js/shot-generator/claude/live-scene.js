// Read-only access to the Shot Generator's live three.js scene, so the prompt
// panel can measure where posed characters' heads really are.

let liveScene = null

export const setLiveScene = scene => { liveScene = scene }

// three.js world (x, up, z) -> Shot Generator (x, y = three z, z = height)
const toSg = v => ({ x: v.x, y: v.z, z: v.y })

/** Head positions keyed by character id; characters still loading are missing. */
export function getHeadPositions (characterIds) {
  const heads = {}
  if (!liveScene) return heads
  const wanted = new Set(characterIds)
  liveScene.traverse(obj => {
    const data = obj.userData
    if (!data || data.type !== 'character' || !wanted.has(data.id) || heads[data.id]) return
    const head = obj.getObjectByName('Head')
    if (!head) return
    obj.updateMatrixWorld(true)
    const p = head.getWorldPosition(head.position.clone())
    heads[data.id] = toSg(p)
  })
  return heads
}

/** Resolves once every character has a head in the scene, or after `timeoutMs`. */
export function waitForHeads (characterIds, timeoutMs = 4000) {
  const started = Date.now()
  return new Promise(resolve => {
    const tick = () => {
      const heads = getHeadPositions(characterIds)
      if (Object.keys(heads).length === characterIds.length || Date.now() - started > timeoutMs) {
        resolve(heads)
      } else {
        setTimeout(tick, 100)
      }
    }
    // give React a frame to mount the new characters
    setTimeout(tick, 100)
  })
}
