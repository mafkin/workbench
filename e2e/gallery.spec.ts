import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { encodePng } from '../server/thumbs.ts'
import { ALPHA, closeChats, resetFixture, SPAWN_LOG, THUMBS, WORK, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const gallery = (page: Page) => page.getByRole('listbox', { name: 'Gallery' })
const tile = (page: Page, name: string) => gallery(page).getByRole('option', { name, exact: true })
const preview = (page: Page) => page.getByRole('complementary', { name: 'Preview' })
const ASSETS = path.join(ALPHA, 'assets')

/** A solid-colour PNG. */
const png = (w: number, h: number, rgba: number[]) => encodePng(w, h, Buffer.from(Array.from({ length: w * h }, () => rgba).flat()))

/** A glTF triangle whose vertices sit in a .bin beside it. */
function triangle() {
  const bin = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4))
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ uri: 'tri.bin', byteLength: 36 }],
  }
  return { gltf: JSON.stringify(gltf), bin }
}

/** Half a second of a 440 Hz tone, 8 kHz mono 16-bit. */
function wav(): Buffer {
  const rate = 8000
  const n = rate / 2
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + n * 2, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000 * (1 - i / n)), 44 + i * 2)
  return out
}

/** A classic .blend with a 2×2 preview and nothing else. */
function blend(): Buffer {
  const i32 = (v: number) => {
    const b = Buffer.alloc(4)
    b.writeInt32LE(v)
    return b
  }
  const block = (code: string, data: Buffer) => Buffer.concat([Buffer.from(code), i32(data.length), Buffer.alloc(8), i32(0), i32(1), data])
  const pixels = Buffer.from([200, 120, 40, 255, 200, 120, 40, 255, 40, 120, 200, 255, 40, 120, 200, 255])
  return Buffer.concat([Buffer.from('BLENDER-v405'), block('TEST', Buffer.concat([i32(2), i32(2), pixels])), block('ENDB', Buffer.alloc(0))])
}

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  fs.mkdirSync(path.join(ASSETS, 'game'), { recursive: true })
  fs.writeFileSync(path.join(ASSETS, 'red.png'), png(64, 48, [200, 60, 60, 255]))
  fs.writeFileSync(path.join(ASSETS, 'blue.png'), png(64, 48, [60, 90, 200, 255]))
  const { gltf, bin } = triangle()
  fs.writeFileSync(path.join(ASSETS, 'tri.gltf'), gltf)
  fs.writeFileSync(path.join(ASSETS, 'tri.bin'), bin)
  fs.writeFileSync(path.join(ASSETS, 'tone.wav'), wav())
  fs.writeFileSync(path.join(ASSETS, 'ship.blend'), blend())
  fs.writeFileSync(path.join(ASSETS, 'notes.txt'), 'text\n')
  fs.writeFileSync(path.join(ASSETS, 'game/project.godot'), '[application]\nconfig/name="Game"\nconfig/icon="res://icon.png"\n')
  fs.writeFileSync(path.join(ASSETS, 'game/icon.png'), png(16, 16, [90, 180, 90, 255]))
  fs.writeFileSync(path.join(ASSETS, 'game/main.tscn'), '[gd_scene format=3]\n')
  // Blender and Godot aren't installed here; rules of the profile's own run as written (into the fake spawn's log).
  await writeWork(WORK.replace('notes: ~/notes\n', 'notes: ~/notes\nopenWith:\n  - { ext: [blend], command: blender }\n  - { ext: [tscn], command: godot, args: [--editor, --path, "{godot}"] }\n'))
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
  await entry(page, 'Alpha').click()
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'assets', exact: true }).dblclick()
  await page.getByRole('radio', { name: 'Gallery' }).click()
})

test.afterAll(closeChats)

test('the gallery: thumbnails made and cached, type filters, tile size, remembered per folder', async ({ page }) => {
  for (const name of ['red.png', 'blue.png', 'tri.gltf', 'tone.wav', 'ship.blend', 'game']) {
    await expect(tile(page, name).locator('img')).toBeVisible({ timeout: 15_000 })
  }
  await expect(tile(page, 'notes.txt').locator('img')).toHaveCount(0)
  // The browser's thumbnails went to the cache (the .blend's the service made itself).
  await expect.poll(() => (fs.existsSync(THUMBS) ? fs.readdirSync(THUMBS).length : 0)).toBeGreaterThanOrEqual(6)
  await page.screenshot({ path: 'test-results/gallery.png' })

  await page.getByRole('radio', { name: /^Images/ }).click()
  await expect(gallery(page).getByRole('option')).toHaveCount(2)
  await page.getByRole('radio', { name: /^3D/ }).click()
  await expect(gallery(page).getByRole('option')).toHaveCount(2)
  await page.getByRole('radio', { name: /^All/ }).click()

  const before = (await tile(page, 'red.png').boundingBox())!.width
  await page.getByLabel('Thumbnail size').fill('200')
  await expect.poll(async () => (await tile(page, 'red.png').boundingBox())!.width).toBeGreaterThan(before + 40)

  await tile(page, 'red.png').click()
  await expect(preview(page).getByLabel('Image info')).toHaveText('64 × 48 px · PNG')
  await page.keyboard.press('ArrowLeft')
  await expect(tile(page, 'notes.txt')).toHaveAttribute('aria-selected', 'true')

  await page.reload()
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'assets', exact: true }).dblclick()
  await expect(gallery(page)).toBeVisible()
  // Cached now: shown without being made again.
  await expect(tile(page, 'tri.gltf').locator('img')).toBeVisible()
})

test('previews: a 3D model with its counts, a .blend’s own preview, an audio waveform', async ({ page }) => {
  await tile(page, 'tri.gltf').click()
  await expect(preview(page).getByLabel('Model statistics')).toContainText('3 vertices · 1 triangle · 1 mesh · 1 material')
  await expect(preview(page).locator('.model-canvas canvas')).toBeVisible()
  await preview(page).getByRole('button', { name: 'Wireframe' }).click()
  await expect(preview(page).getByRole('button', { name: 'Wireframe' })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: 'test-results/gallery-model.png' })

  await tile(page, 'ship.blend').click()
  await expect(preview(page)).toContainText('The preview Blender saved in the file')

  await tile(page, 'tone.wav').click()
  await expect(preview(page).getByLabel('Waveform')).toBeVisible()
  await expect(preview(page)).toContainText('mono')
  await expect(preview(page)).toContainText('0:00 / 0:00')
})

test('two images compare with a slider or side by side', async ({ page }) => {
  await tile(page, 'red.png').click()
  await tile(page, 'blue.png').click({ modifiers: ['Control'] })
  await expect(preview(page)).toContainText('Compare')
  await expect(preview(page).getByRole('slider')).toBeVisible()
  await preview(page).getByRole('slider').fill('20')
  await expect(preview(page).locator('.compare-stack .over')).toHaveAttribute('style', /inset\(0px 0px 0px 20%\)/)
  await preview(page).getByRole('radio', { name: 'Side by side' }).click()
  await expect(preview(page).locator('figure')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/gallery-compare.png' })
})

test('Open in Blender and the Godot editor, from the preview and with a double-click', async ({ page }) => {
  await tile(page, 'ship.blend').click()
  await preview(page).getByRole('button', { name: 'Open in Blender' }).click()
  await expect(page.locator('.toast').last()).toContainText('Opened ship.blend in Blender')
  expect(fs.readFileSync(SPAWN_LOG, 'utf8')).toContain(`blender ${path.join(ASSETS, 'ship.blend')}`)

  await tile(page, 'game').dblclick()
  await tile(page, 'main.tscn').dblclick()
  await expect(page.locator('.toast').last()).toContainText('Opened main.tscn in Godot')
  expect(fs.readFileSync(SPAWN_LOG, 'utf8')).toContain(`godot --editor --path ${path.join(ASSETS, 'game')}`)
})
