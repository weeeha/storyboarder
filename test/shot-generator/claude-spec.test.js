const assert = require('assert')
const THREE = require('three')
const { specToScene, sceneToSpec, frameCamera, lensToFov, fovToLens } = require('../../src/js/shot-generator/claude/spec-to-scene')
const poses = require('../../src/js/shared/reducers/shot-generator-presets/poses.json')

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

let n = 0
const newId = () => `id-${++n}`

// Direction an object actually looks once the Shot Generator applies
// rotation.y = yaw, then rotateX(tilt), using three.js itself.
function worldForward (obj, localForward) {
  const o = new THREE.Object3D()
  o.rotation.y = obj.rotation
  o.rotateX(obj.tilt || 0)
  return localForward.clone().applyQuaternion(o.quaternion)
}

describe('claude shot spec', () => {
  const baseSpec = {
    characters: [
      { name: 'Maya', model: 'adult-female', x: -0.6, y: 0, pose: 'Sitting', lookAt: { x: 0.6, y: 0 } },
      { name: 'Theo', model: 'adult-male', x: 0.6, y: 0, pose: 'no such pose sitting', lookAt: { x: -0.6, y: 0 } }
    ],
    objects: [{ name: 'Table', model: 'table-small-square', x: 0, y: 0 }],
    lights: [{ name: 'Key', x: 0, y: 0, z: 2.5, aimAt: { x: 0, y: 0, z: 0 } }],
    camera: { x: 1, y: -3, z: 0.6, lookAt: { x: -0.6, y: 0, z: 1.3 }, lensMm: 35 }
  }

  it('aims the camera at its lookAt point (checked with three.js)', () => {
    const scene = specToScene(baseSpec, { scene: null, poses, newId })
    const cam = scene.sceneObjects[scene.activeCamera]
    const fwd = worldForward(cam, new THREE.Vector3(0, 0, -1))
    // expected direction, converted to three.js axes (x, height, y)
    const want = new THREE.Vector3(-0.6 - 1, 1.3 - 0.6, 0 - -3).normalize()
    near(fwd.x, want.x); near(fwd.y, want.y); near(fwd.z, want.z)
  })

  it('aims lights at their target (light faces +Z)', () => {
    const scene = specToScene(baseSpec, { scene: null, poses, newId })
    const light = Object.values(scene.sceneObjects).find(o => o.type === 'light')
    const fwd = worldForward(light, new THREE.Vector3(0, 0, 1))
    near(fwd.y, -1) // straight down
  })

  it('turns characters toward their lookAt (character faces +Z)', () => {
    const scene = specToScene(baseSpec, { scene: null, poses, newId })
    const maya = Object.values(scene.sceneObjects).find(o => o.name === 'Maya')
    const fwd = worldForward({ rotation: maya.rotation }, new THREE.Vector3(0, 0, 1))
    near(fwd.x, 1) // Theo is at +x
  })

  it('matches three.js setFocalLength for lens <-> fov', () => {
    const cam = new THREE.PerspectiveCamera(50, 2.348927875243665)
    for (const mm of [18, 24, 35, 50, 85, 135]) {
      cam.setFocalLength(mm)
      near(lensToFov(mm), cam.fov)
      near(fovToLens(cam.fov), mm)
    }
  })

  it('maps pose names to presets, falls back by keyword, and copies the skeleton', () => {
    const scene = specToScene(baseSpec, { scene: null, poses, newId })
    const [maya, theo] = Object.values(scene.sceneObjects).filter(o => o.type === 'character')
    assert.ok(poses[maya.posePresetId])
    assert.deepStrictEqual(maya.skeleton, poses[maya.posePresetId].state.skeleton)
    assert.ok(/sit/i.test(poses[theo.posePresetId].name + poses[theo.posePresetId].keywords))
  })

  it('round-trips through sceneToSpec and keeps ids, extra cameras and images', () => {
    const first = specToScene(baseSpec, { scene: null, poses, newId })
    first.sceneObjects.extraCam = { id: 'extraCam', type: 'camera', x: 0, y: 0, z: 1, rotation: 0, tilt: 0, roll: 0, fov: 22 }
    first.sceneObjects.img = { id: 'img', type: 'image', x: 0, y: 0, z: 1 }
    const spec = sceneToSpec(first, poses)
    assert.strictEqual(spec.characters.length, 2)
    assert.strictEqual(spec.camera.id, first.activeCamera)
    near(spec.camera.lensMm, 35, 0.6)

    spec.camera.lensMm = 85
    const second = specToScene(spec, { scene: first, poses, newId })
    assert.deepStrictEqual(Object.keys(second.sceneObjects).sort(), Object.keys(first.sceneObjects).sort())
    near(fovToLens(second.sceneObjects[second.activeCamera].fov), 85)
  })

  it('keeps a pose through an edit after the app cleared posePresetId', () => {
    const first = specToScene(baseSpec, { scene: null, poses, newId })
    const maya = Object.values(first.sceneObjects).find(o => o.name === 'Maya')
    const appliedName = maya.poseName
    // what the Shot Generator does after load: skeleton drifts, preset id cleared
    const bone = Object.keys(maya.skeleton)[0]
    maya.skeleton = { ...maya.skeleton, [bone]: { rotation: { x: 0.123, y: 0, z: 0 } } }
    maya.posePresetId = undefined
    maya.displayName = 'Maya 1'

    const spec = sceneToSpec(first, poses)
    const specMaya = spec.characters.find(c => c.id === maya.id)
    assert.strictEqual(specMaya.name, 'Maya')
    assert.strictEqual(specMaya.pose, appliedName)

    const second = specToScene(spec, { scene: first, poses, newId })
    assert.deepStrictEqual(second.sceneObjects[maya.id].skeleton, maya.skeleton)

    // asking for a different pose does replace it
    specMaya.pose = 'Running'
    const third = specToScene(spec, { scene: first, poses, newId })
    assert.notDeepStrictEqual(third.sceneObjects[maya.id].skeleton, maya.skeleton)
    assert.strictEqual(third.sceneObjects[maya.id].poseName, 'Running')
  })

  it('frames an over-the-shoulder close-up from measured head positions', () => {
    const scene = specToScene(baseSpec, { scene: null, poses, newId })
    const maya = Object.values(scene.sceneObjects).find(o => o.name === 'Maya')
    const theo = Object.values(scene.sceneObjects).find(o => o.name === 'Theo')
    const heads = { [maya.id]: { x: -0.5, y: 0, z: 1.1 }, [theo.id]: { x: 0.6, y: 0, z: 1.15 } }
    const cam = frameCamera(scene, { subject: 'Maya', shotSize: 'CU', overShoulderOf: 'theo' }, heads)

    // behind Theo (further from Maya than Theo is) and off to the side
    assert.ok(cam.x > 0.6)
    assert.ok(Math.abs(cam.y) > 0.2)
    // looking at Maya: forward vector points toward her
    const fwd = worldForward(cam, new THREE.Vector3(0, 0, -1))
    const toMaya = new THREE.Vector3(-0.5 - cam.x, 1.1 + 0.08 - 0.35 / 6 - cam.z, 0 - cam.y).normalize()
    near(fwd.dot(toMaya), 1, 1e-6)
    // the vertical field of view covers 0.35m at her distance (lens not clamped here)
    const dist = Math.hypot(-0.5 - cam.x, 0 - cam.y, (1.1 + 0.08 - 0.35 / 6) - cam.z)
    near(2 * Math.tan((cam.fov * Math.PI / 180) / 2) * dist, 0.35, 1e-3)
  })

  // Project scene points through a three.js camera set up the way the
  // Shot Generator applies camera state (CameraUpdate.js).
  function project (cam, aspect, p) {
    const c = new THREE.PerspectiveCamera(cam.fov, aspect, 0.01, 100)
    c.position.set(cam.x, cam.z, cam.y)
    c.rotation.y = cam.rotation
    c.rotateX(cam.tilt)
    c.updateMatrixWorld(true)
    return new THREE.Vector3(p.x, p.z, p.y).project(c)
  }

  for (const shotSize of ['CU', 'MCU', 'MS']) {
    it(`over-the-shoulder ${shotSize}: subject's eyes on the upper third, near head toward the frame edge but off her face`, () => {
      const scene = specToScene(baseSpec, { scene: null, poses, newId })
      const maya = Object.values(scene.sceneObjects).find(o => o.name === 'Maya')
      const theo = Object.values(scene.sceneObjects).find(o => o.name === 'Theo')
      const mayaHead = { x: -0.5, y: 0.1, z: 1.1 }
      const theoHead = { x: 0.6, y: -0.05, z: 1.15 }
      const aspect = 2.348927875243665
      const cam = frameCamera(scene, { subject: 'Maya', shotSize, overShoulderOf: 'Theo' }, { [maya.id]: mayaHead, [theo.id]: theoHead }, aspect)

      const eyes = project(cam, aspect, { ...mayaHead, z: mayaHead.z + 0.08 })
      near(eyes.x, 0, 1e-6)
      near(eyes.y, 1 / 3, 0.02) // NDC +1/3 = upper third line

      const near_ = project(cam, aspect, { ...theoHead, z: theoHead.z + 0.08 })
      assert.ok(near_.z < 1, 'near head is in front of the far plane')
      assert.ok(Math.abs(near_.x) > 0.45 && Math.abs(near_.x) < 1.0, `near head x in frame: ${near_.x}`)
    })
  }

  it('returns null when the subject has no measured head', () => {
    const scene = specToScene(baseSpec, { scene: null, poses, newId })
    assert.strictEqual(frameCamera(scene, { subject: 'Maya', shotSize: 'CU' }, {}), null)
  })

  it('drops characters the new spec leaves out, and their attachables', () => {
    const first = specToScene(baseSpec, { scene: null, poses, newId })
    const maya = Object.values(first.sceneObjects).find(o => o.name === 'Maya')
    first.sceneObjects.hat = { id: 'hat', type: 'attachable', attachToId: maya.id }
    const spec = sceneToSpec(first, poses)
    spec.characters = spec.characters.filter(c => c.name !== 'Maya')
    const second = specToScene(spec, { scene: first, poses, newId })
    assert.ok(!second.sceneObjects[maya.id])
    assert.ok(!second.sceneObjects.hat)
  })
})
