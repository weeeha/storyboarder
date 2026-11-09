// Main-process bridge: the Shot Generator's prompt panel asks Claude for a shot.
// Runs the `claude` CLI (Claude Code) in print mode, so it uses the signed-in
// user's Claude account and no API key is stored in the app.

const { ipcMain, app } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const catalog = require('../../data/shot-generator/claude-catalog.json')

const MODEL = process.env.STORYBOARDER_CLAUDE_MODEL || 'sonnet'
const TIMEOUT_MS = 120 * 1000

function findClaude () {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(p)) || 'claude'
}

const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y'] }
const point3 = { ...point, required: ['x', 'y', 'z'] }

const SCHEMA = {
  type: 'object',
  required: ['summary', 'characters', 'objects', 'lights', 'camera'],
  properties: {
    summary: { type: 'string', description: 'One sentence saying what you built or changed.' },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'model', 'x', 'y', 'pose'],
        properties: {
          id: { type: 'string', description: 'Keep the id of an existing character you are editing.' },
          name: { type: 'string' },
          model: { type: 'string', enum: catalog.characters.map(c => c.id) },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number', description: 'Height of the feet above the floor; 0 unless standing on something.' },
          height: { type: 'number' },
          pose: { type: 'string', description: 'Exact pose name from the list.' },
          lookAt: point,
          facingDegrees: { type: 'number' }
        }
      }
    },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'model', 'x', 'y'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          model: { type: 'string', enum: catalog.objects.map(o => o.id) },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          facingDegrees: { type: 'number' },
          lookAt: point,
          width: { type: 'number', description: 'Scale factor, 1 = model size' },
          depth: { type: 'number', description: 'Scale factor, 1 = model size' },
          height: { type: 'number', description: 'Scale factor, 1 = model size' }
        }
      }
    },
    lights: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'x', 'y', 'z'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          intensity: { type: 'number' },
          aimAt: point3
        }
      }
    },
    camera: {
      type: 'object',
      required: ['x', 'y', 'z', 'lookAt', 'lensMm'],
      properties: {
        id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        lookAt: point3,
        lensMm: { type: 'number' },
        rollDegrees: { type: 'number' },
        framing: {
          type: 'object',
          description: 'Optional. When set, the app aims the camera at the subject\'s eyes using measured head positions and picks the lens for the shot size; for over-the-shoulder it also places the camera.',
          required: ['subject', 'shotSize'],
          properties: {
            subject: { type: 'string', description: 'Name of the character the shot is on.' },
            shotSize: { type: 'string', enum: ['ECU', 'CU', 'MCU', 'MS', 'MWS', 'WS', 'EWS'] },
            overShoulderOf: { type: 'string', description: 'Name of the foreground character, for over-the-shoulder.' },
            side: { type: 'string', enum: ['left', 'right'] }
          }
        }
      }
    }
  }
}

const objectLines = catalog.objects
  .map(o => `${o.id} (${o.name}): ${o.size.width}w x ${o.size.depth}d x ${o.size.height}h m`)
  .join('\n')
const characterLines = catalog.characters.map(c => `${c.id}: ${c.modelHeight} m tall`).join('\n')

const SYSTEM_PROMPT = `You are a storyboard artist and cinematographer blocking shots in Storyboarder's 3D Shot Generator. You turn a shot description into a scene: characters, props, lights and one camera. Reply only with the structured output.

Coordinates, in metres:
- x and y lie on the floor; z is height above the floor. The floor is z = 0.
- Characters face +y when facingDegrees is 0, and +x at 90. Prefer lookAt (a floor point) to face someone or something.
- Props at facingDegrees 0 have their width along x and their depth along y. A prop's x, y is the centre of its footprint; z is the height of its base (0 = on the floor).
- Keep the action near the origin.

Camera:
- x, y, z is the lens position; lookAt is the point at the centre of frame.
- Eye level for a standing adult is about 1.6 m; seated, about 1.2 m. Low angle: camera at 0.3 to 0.8 m looking up. High angle: camera above the subject's eyes looking down.
- Framing with a 35mm lens, camera-to-subject distance: wide/full shot 4 to 6 m, medium 1.8 to 2.5 m, medium close-up 1.2 to 1.5 m, close-up 0.7 to 1 m, extreme close-up 0.4 m. Longer lenses push these distances out in proportion (an 85mm close-up is about 2.2 m away).
- Shots on one character (singles, close-ups, over-the-shoulder): set camera.framing with the subject, shot size (ECU, CU, MCU, MS, MWS, WS, EWS) and, for over-the-shoulder, overShoulderOf. The app then measures where the posed heads really are and places, aims and lenses the camera itself, so your x, y, z, lookAt and lensMm only need to be roughly right. For over-the-shoulder, put x, y, z roughly behind the near character. Leave framing out for two-shots, group shots and anything that frames a space rather than a face.
- Characters in the current scene carry "head": the measured position of the head bone (eyes are about 0.08 m above it). Use it instead of estimating.
- Point lookAt at the faces that matter (face height = character height minus about 0.12 m, lower when seated). For a close-up, lookAt is the subject's eyes.
- Keep the sightline clear: no prop or other character's head between the lens and the faces in frame. If something blocks it, move the camera sideways or up, or move the prop if the request allows.
- Over-the-shoulder and close-ups keep the camera at the subject's eye height, not above it, unless the request asks for a high or low angle.

Characters:
- model must be one of the list. Use height only to change a character's size from the model's default.
- For a seated character, place the model where the seat is; the sitting poses already bend the legs. Seated characters at a table sit about 0.45 m from the table edge.
- Dining and kitchen tables take chair-box (or chair-modern for armchairs). chair-bar and chair-stool are for counters and bars only.
- pose must be one name copied exactly from the pose list.

Lights (optional): spot lights. Put them above or beside the action and give aimAt. Intensity 0.5 to 1.2.

Editing: when the request includes a current scene, change only what the request asks for, keep the ids of everything you keep, and return the whole scene. Leave something out to delete it. Copy each character's pose value unchanged unless the request changes that character's pose ("custom" means a hand-made pose: keep it).

Character models:
${characterLines}

Props (size at scale 1):
${objectLines}

Poses:
${catalog.poseNames.join('\n')}`

function runClaude (userMessage) {
  return new Promise((resolve, reject) => {
    // An empty working folder, with only "local" settings and no MCP servers,
    // keeps the user's own hooks, CLAUDE.md and tools out of these calls.
    const cwd = path.join(app.getPath('temp'), 'storyboarder-claude')
    fs.mkdirSync(cwd, { recursive: true })

    const args = [
      '-p',
      '--model', MODEL,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA),
      '--system-prompt', SYSTEM_PROMPT,
      '--tools', '',
      '--setting-sources', 'local',
      '--strict-mcp-config',
      '--no-session-persistence'
    ]

    const child = spawn(findClaude(), args, {
      cwd,
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Claude took longer than 2 minutes. Nothing was changed.'))
    }, TIMEOUT_MS)

    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(err.code === 'ENOENT'
        ? 'Could not find the claude command. Install Claude Code, or set CLAUDE_BIN to its path.'
        : err.message))
    })
    child.on('close', code => {
      clearTimeout(timer)
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (e) {
        return reject(new Error((stderr || stdout || `claude exited with code ${code}`).trim().slice(0, 400)))
      }
      if (parsed.is_error || !parsed.structured_output) {
        return reject(new Error(String(parsed.result || 'Claude returned no shot.').slice(0, 400)))
      }
      resolve({ spec: parsed.structured_output, costUsd: parsed.total_cost_usd, durationMs: parsed.duration_ms })
    })

    child.stdin.end(userMessage)
  })
}

function buildMessage ({ prompt, currentSpec, boardInfo }) {
  const parts = []
  if (boardInfo) parts.push(`Board context: ${boardInfo}`)
  if (currentSpec) {
    parts.push(`Current scene (edit it):\n${JSON.stringify(currentSpec)}`)
  } else {
    parts.push('Start from an empty scene.')
  }
  parts.push(`Request: ${prompt}`)
  return parts.join('\n\n')
}

function init () {
  ipcMain.handle('claude:build-shot', async (event, request) => {
    return runClaude(buildMessage(request))
  })
}

module.exports = { init, buildMessage, SCHEMA, SYSTEM_PROMPT }
