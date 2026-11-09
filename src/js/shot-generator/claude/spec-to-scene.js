// Converts between the Shot Generator's scene state and the compact "shot spec"
// Claude reads and writes. Pure functions: no Electron, no three.js, no DOM.
//
// Spec coordinates are the Shot Generator's own: metres, x/y on the ground
// plane, z is height above the floor. Angles in the spec are degrees.
// Scene state stores radians, and three.js maps (x, y, z) to (x, z, y).

const DEG = Math.PI / 180

// Same constants the camera inspector uses (CameraPanelInspector: a
// PerspectiveCamera with aspect 2.3489 and three.js's default 35mm film gauge),
// so a lens Claude asks for reads back as the same mm in the inspector.
const FAKE_CAMERA_ASPECT = 2.348927875243665
const FILM_GAUGE = 35
const filmHeight = FILM_GAUGE / Math.max(FAKE_CAMERA_ASPECT, 1)

const lensToFov = mm => 2 * Math.atan((0.5 * filmHeight) / mm) / DEG
const fovToLens = fov => (0.5 * filmHeight) / Math.tan((fov * DEG) / 2)

const DEFAULT_POSE_ID = '79BBBD0D-6BA2-4D84-9B71-EE661AB6E5AE' // "stand"

// Measured from the dummy GLBs (tools/build-claude-catalog.mjs)
const MODEL_HEIGHTS = {
  'adult-male': 1.8, 'adult-female': 1.63, 'teen-male': 1.6, 'teen-female': 1.6, child: 1.11, baby: 0.46
}

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places

// Yaw/tilt that aim an object at a point.
// Cameras look down local -Z; lights and characters face local +Z.
// The Shot Generator applies rotation.y = yaw, then rotateX(tilt).
function aim (from, to, forward) {
  const dx = to.x - from.x
  const dz = to.y - from.y // spec y is three.js z
  const dy = (to.z || 0) - (from.z || 0) // spec z is height
  const horizontal = Math.hypot(dx, dz)
  if (forward === '-z') {
    return { yaw: Math.atan2(-dx, -dz), tilt: Math.atan2(dy, horizontal) }
  }
  return { yaw: Math.atan2(dx, dz), tilt: Math.atan2(-dy, horizontal) }
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'with', 'no', 'not', 'such', 'pose', 'posed', 'is', 'her', 'his', 'their'])
const tokens = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP_WORDS.has(w))

function poseFinder (poses) {
  const list = Object.values(poses)
  const byName = new Map(list.map(p => [p.name.toLowerCase(), p]))
  return name => {
    if (!name) return poses[DEFAULT_POSE_ID]
    const exact = byName.get(String(name).toLowerCase())
    if (exact) return exact
    // closest by shared word stems in name + keywords; shorter names win ties
    const stem = w => w.replace(/(ing|ed|s)$/, '')
    const words = tokens(name).map(stem)
    let best = null
    let bestScore = 0
    for (const p of list) {
      const hay = new Set(tokens(`${p.name} ${p.keywords || ''}`).map(stem))
      const score = words.filter(w => hay.has(w)).length
      if (score > bestScore || (score === bestScore && score > 0 && p.name.length < best.name.length)) {
        best = p
        bestScore = score
      }
    }
    return best || poses[DEFAULT_POSE_ID]
  }
}

function poseNameOf (obj, poses) {
  if (obj.posePresetId && poses[obj.posePresetId]) return poses[obj.posePresetId].name
  return obj.poseName || 'custom'
}

// The app derives displayName ("Maya 1") from name; we only ever set name.
const nameOf = (obj, fallback) => obj.name || fallback

function facingYaw (item) {
  if (item.lookAt) return aim(item, item.lookAt, '+z').yaw
  return (item.facingDegrees || 0) * DEG
}

// Scene objects of these types are not in the spec; they survive a rebuild.
const PRESERVED_TYPES = new Set(['image', 'volume'])

/**
 * @param {object} spec       Claude's shot spec
 * @param {object} context
 * @param {object} context.scene     current serialized scene { world, sceneObjects, activeCamera }
 * @param {object} context.poses     pose presets keyed by id (poses.json)
 * @param {function} context.newId   id generator
 * @returns {{ world, sceneObjects, activeCamera }}
 */
function specToScene (spec, { scene, poses, newId }) {
  const current = (scene && scene.sceneObjects) || {}
  const findPose = poseFinder(poses)
  const sceneObjects = {}
  const idFor = item => (item.id && current[item.id] ? item.id : newId())

  for (const c of spec.characters || []) {
    const id = idFor(c)
    const prev = current[id]
    // The Shot Generator clears posePresetId once a loaded skeleton drifts from
    // the preset, so the pose we applied is remembered in `poseName`.
    // Same name (or "custom") on an existing character = leave its pose alone.
    const unchanged = prev && prev.skeleton &&
      (c.pose === 'custom' || c.pose === poseNameOf(prev, poses))
    const pose = unchanged ? null : findPose(c.pose)
    sceneObjects[id] = {
      ...(prev || {}),
      id,
      type: 'character',
      name: c.name,
      model: c.model || 'adult-male',
      height: c.height || (prev && prev.model === c.model && prev.height) || MODEL_HEIGHTS[c.model] || 1.8,
      headScale: (prev && prev.headScale) || 1,
      tintColor: (prev && prev.tintColor) || '#000000',
      morphTargets: (prev && prev.morphTargets) || { mesomorphic: 0, ectomorphic: 0, endomorphic: 0 },
      x: c.x,
      y: c.y,
      z: c.z || 0,
      rotation: facingYaw(c),
      posePresetId: unchanged ? prev.posePresetId : pose.id,
      poseName: unchanged ? poseNameOf(prev, poses) : pose.name,
      skeleton: unchanged ? prev.skeleton : pose.state.skeleton,
      visible: true
    }
  }

  for (const o of spec.objects || []) {
    const id = idFor(o)
    const prev = current[id]
    sceneObjects[id] = {
      ...(prev || {}),
      id,
      type: 'object',
      name: o.name,
      model: o.model || 'box',
      x: o.x,
      y: o.y,
      z: o.z || 0,
      width: o.width || 1,
      height: o.height || 1,
      depth: o.depth || 1,
      rotation: { x: 0, y: facingYaw(o), z: 0 },
      tintColor: (prev && prev.tintColor) || '#000000',
      visible: true
    }
  }

  for (const l of spec.lights || []) {
    const id = idFor(l)
    const prev = current[id]
    const { yaw, tilt } = l.aimAt ? aim(l, l.aimAt, '+z') : { yaw: 0, tilt: Math.PI / 2 }
    sceneObjects[id] = {
      angle: 1.04,
      distance: 5,
      penumbra: 1,
      decay: 1,
      ...(prev || {}),
      id,
      type: 'light',
      name: l.name,
      x: l.x,
      y: l.y,
      z: l.z,
      rotation: yaw,
      tilt,
      roll: 0,
      intensity: l.intensity == null ? 0.8 : l.intensity,
      visible: true
    }
  }

  const cam = spec.camera
  const cameraId = cam.id && current[cam.id] ? cam.id : (scene && scene.activeCamera) || newId()
  const { yaw, tilt } = aim(cam, cam.lookAt, '-z')
  sceneObjects[cameraId] = {
    ...(current[cameraId] || {}),
    id: cameraId,
    type: 'camera',
    x: cam.x,
    y: cam.y,
    z: cam.z,
    rotation: yaw,
    tilt,
    roll: (cam.rollDegrees || 0) * DEG,
    fov: lensToFov(cam.lensMm || 35)
  }

  // Keep other cameras, plus types the spec does not describe.
  // Attachables survive only if their character does.
  for (const [id, obj] of Object.entries(current)) {
    if (sceneObjects[id]) continue
    if (obj.type === 'camera' && spec.keepOtherCameras !== false) sceneObjects[id] = obj
    else if (PRESERVED_TYPES.has(obj.type)) sceneObjects[id] = obj
    else if (obj.type === 'attachable' && sceneObjects[obj.attachToId]) sceneObjects[id] = obj
  }

  return {
    world: scene && scene.world,
    sceneObjects,
    activeCamera: cameraId
  }
}

/** The current scene in spec form, so Claude can edit it instead of starting over. */
function sceneToSpec (scene, poses) {
  const objs = Object.values((scene && scene.sceneObjects) || {})
  const active = objs.find(o => o.id === (scene && scene.activeCamera))
  const spec = { characters: [], objects: [], lights: [], camera: null }

  for (const o of objs) {
    if (o.type === 'character') {
      spec.characters.push({
        id: o.id,
        name: nameOf(o, 'Character'),
        model: o.model,
        x: round(o.x), y: round(o.y), z: round(o.z || 0),
        facingDegrees: round(o.rotation / DEG, 0),
        pose: poseNameOf(o, poses),
        height: round(o.height)
      })
    } else if (o.type === 'object') {
      spec.objects.push({
        id: o.id,
        name: nameOf(o, o.model),
        model: o.model,
        x: round(o.x), y: round(o.y), z: round(o.z || 0),
        facingDegrees: round(((o.rotation && o.rotation.y) || 0) / DEG, 0),
        width: o.width, height: o.height, depth: o.depth
      })
    } else if (o.type === 'light') {
      spec.lights.push({
        id: o.id,
        name: nameOf(o, 'Light'),
        x: round(o.x), y: round(o.y), z: round(o.z),
        intensity: o.intensity
      })
    }
  }

  if (active) {
    // a point 3m along the camera's view direction stands in for lookAt
    const cosT = Math.cos(active.tilt || 0)
    const dirX = -Math.sin(active.rotation) * cosT
    const dirY = -Math.cos(active.rotation) * cosT
    const dirZ = Math.sin(active.tilt || 0)
    spec.camera = {
      id: active.id,
      x: round(active.x), y: round(active.y), z: round(active.z),
      lookAt: { x: round(active.x + dirX * 3), y: round(active.y + dirY * 3), z: round(active.z + dirZ * 3) },
      lensMm: round(fovToLens(active.fov), 0),
      rollDegrees: round((active.roll || 0) / DEG, 0)
    }
  }
  return spec
}

// How much of the subject fills the frame, as the frame's height in metres at
// the subject. Eyes sit on the upper third.
const SHOT_SIZES = {
  ECU: 0.15, // eyes and mouth
  CU: 0.35, // head and neck
  MCU: 0.6, // to mid-chest
  MS: 0.95, // to the waist
  MWS: 1.5, // to the knees
  WS: 2.4, // full body with room
  EWS: 6 // figure small in the space
}
const EYE_ABOVE_HEAD_BONE = 0.08
const MIN_LENS = 14
const MAX_LENS = 200

// Over-the-shoulder: where the near character's head sits across the frame
// (0 = centre, 1 = edge), and how far from the lens axis it must stay so it
// does not cover the subject's face.
const OTS_HEAD_IN_FRAME = 0.75
const OTS_CLEARANCE = 0.2
const OTS_MIN_BACK = 0.35
const OTS_MAX_BACK = 3

/**
 * Places the active camera from a framing intent and measured head positions.
 * @param {object} scene    result of specToScene
 * @param {object} framing  { subject, shotSize, overShoulderOf?, side? } (names)
 * @param {object} heads    { [characterId]: {x, y, z} } head bone positions
 * @returns {object|null}   camera fields to update, or null if a head is missing
 */
function frameCamera (scene, framing, heads, aspect = FAKE_CAMERA_ASPECT) {
  if (!framing || !framing.subject) return null
  const byName = name => Object.values(scene.sceneObjects)
    .find(o => o.type === 'character' && String(o.name).toLowerCase() === String(name).toLowerCase())
  const subject = byName(framing.subject)
  if (!subject || !heads[subject.id]) return null

  const frameHeight = SHOT_SIZES[framing.shotSize] || SHOT_SIZES.MS
  const s = heads[subject.id]
  const eyes = { x: s.x, y: s.y, z: s.z + EYE_ABOVE_HEAD_BONE }
  // eye line on the upper third: aim a sixth of the frame below the eyes
  const target = { x: eyes.x, y: eyes.y, z: eyes.z - frameHeight / 6 }

  const cam = scene.sceneObjects[scene.activeCamera]
  let pos = { x: cam.x, y: cam.y, z: cam.z }

  const near = framing.overShoulderOf && byName(framing.overShoulderOf)
  if (near && heads[near.id]) {
    const n = heads[near.id]
    let ux = eyes.x - n.x
    let uy = eyes.y - n.y
    const L = Math.hypot(ux, uy) || 1 // near head to subject, on the floor plane
    ux /= L; uy /= L
    // With the camera b metres behind the near head and s to the side, the near
    // head sits s*L/(L+b) from the lens axis, while half the frame width there
    // is b*aspect*H/(2(L+b)). Fixing the head at OTS_HEAD_IN_FRAME of that
    // half-width gives s = k*b*aspect*H/(2L); keeping it OTS_CLEARANCE from
    // the axis gives b/(L+b) >= 2*clearance/(k*aspect*H).
    const k = OTS_HEAD_IN_FRAME
    const ratio = Math.min(0.75, (2 * OTS_CLEARANCE) / (k * aspect * frameHeight))
    const b = Math.min(OTS_MAX_BACK, Math.max(OTS_MIN_BACK, (ratio * L) / (1 - ratio)))
    const side = (k * b * aspect * frameHeight) / (2 * L)
    // camera's right, looking from behind the near character toward the subject
    const sign = framing.side === 'left' ? -1 : 1
    const rx = uy * sign
    const ry = -ux * sign
    pos = {
      x: n.x - ux * b + rx * side,
      y: n.y - uy * b + ry * side,
      z: n.z + EYE_ABOVE_HEAD_BONE
    }
  }

  const { yaw, tilt } = aim(pos, target, '-z')
  const distance = Math.hypot(target.x - pos.x, target.y - pos.y, target.z - pos.z)
  const fov = 2 * Math.atan(frameHeight / 2 / distance) / DEG
  const lens = Math.min(MAX_LENS, Math.max(MIN_LENS, fovToLens(fov)))

  return { ...pos, rotation: yaw, tilt, fov: lensToFov(lens) }
}

module.exports = { specToScene, sceneToSpec, frameCamera, SHOT_SIZES, aim, lensToFov, fovToLens, DEFAULT_POSE_ID }
