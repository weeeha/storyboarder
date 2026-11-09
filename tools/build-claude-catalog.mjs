#!/usr/bin/env node
// Builds src/data/shot-generator/claude-catalog.json: the props, character
// models and pose names Claude may use, with real sizes measured from the GLBs.
// Re-run after adding models or poses:  node tools/build-claude-catalog.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const THREE = require('three')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = join(root, 'src/data/shot-generator')

function readGlbJson (file) {
  const buf = readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`)
  const len = buf.readUInt32LE(12)
  return JSON.parse(buf.slice(20, 20 + len).toString('utf8'))
}

// World-space bounding box from POSITION accessor min/max through the node tree.
function measure (file) {
  const gltf = readGlbJson(file)
  const box = new THREE.Box3()
  const visit = (index, parent) => {
    const node = gltf.nodes[index]
    const local = new THREE.Matrix4()
    if (node.matrix) local.fromArray(node.matrix)
    else {
      local.compose(
        new THREE.Vector3(...(node.translation || [0, 0, 0])),
        new THREE.Quaternion(...(node.rotation || [0, 0, 0, 1])),
        new THREE.Vector3(...(node.scale || [1, 1, 1]))
      )
    }
    const world = parent.clone().multiply(local)
    if (node.mesh != null) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const acc = gltf.accessors[prim.attributes.POSITION]
        if (!acc.min || !acc.max) continue
        const b = new THREE.Box3(new THREE.Vector3(...acc.min), new THREE.Vector3(...acc.max))
        box.union(b.applyMatrix4(world))
      }
    }
    for (const child of node.children || []) visit(child, world)
  }
  const scene = gltf.scenes[gltf.scene || 0]
  for (const n of scene.nodes) visit(n, new THREE.Matrix4())
  const size = box.getSize(new THREE.Vector3())
  const r = n => Math.round(n * 100) / 100
  // three.js (x, y=up, z) -> Shot Generator (width x, depth y, height z)
  return { width: r(size.x), depth: r(size.z), height: r(size.y), baseZ: r(box.min.y) }
}

const objectsJson = JSON.parse(readFileSync(join(data, 'objects/objects.json'), 'utf8'))
const objects = Object.values(objectsJson).map(o => ({
  id: o.id,
  name: o.name,
  size: measure(join(data, 'objects', `${o.id}.glb`))
}))
objects.push({ id: 'box', name: 'Box (1m cube, scale with width/depth/height)', size: { width: 1, depth: 1, height: 1, baseZ: 0 } })

const characters = ['adult-male', 'adult-female', 'teen-male', 'teen-female', 'child', 'baby'].map(id => ({
  id,
  modelHeight: measure(join(data, 'dummies/gltf', `${id}.glb`)).height
}))

const poses = JSON.parse(readFileSync(join(root, 'src/js/shared/reducers/shot-generator-presets/poses.json'), 'utf8'))
const poseNames = [...new Set(Object.values(poses).map(p => p.name))].sort((a, b) => a.localeCompare(b))

writeFileSync(join(data, 'claude-catalog.json'), JSON.stringify({ objects, characters, poseNames }, null, 1) + '\n')
console.log(`objects ${objects.length}, characters ${characters.length}, poses ${poseNames.length}`)
for (const o of objects.filter(o => /table-sit|chair-modern|door-single$|vehicle-car/.test(o.id))) console.log(o.id, o.size)
for (const c of characters) console.log(c.id, c.modelHeight)
