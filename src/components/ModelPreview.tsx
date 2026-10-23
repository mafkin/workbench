// A 3D model in the preview pane (a lazy chunk with three.js): glTF/GLB, OBJ
// (with its .mtl), FBX and STL, loaded through a folder ticket so textures and
// .bin files beside the model come too. Drag to turn, scroll to zoom,
// right-drag to pan; wireframe and grid toggles; counts of what is in it. The
// same scene renders the gallery's 3D thumbnails.
import { Box, Grid3x3, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import * as api from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { THUMB_PX } from '../lib/thumbs.ts'

export interface ModelStats {
  vertices: number
  triangles: number
  meshes: number
  materials: number
  /** Width, height and depth of its bounding box. */
  size: [number, number, number]
}

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/** Load a model from a ticket URL; `name` says its format. */
export async function loadModel(url: string, name: string): Promise<THREE.Object3D> {
  const ext = extOf(name)
  if (ext === 'gltf' || ext === 'glb') {
    try {
      return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)).scene
    } catch (err) {
      if (/draco/i.test(String(err))) throw new Error('This glTF uses Draco compression, which the viewer cannot read')
      throw err
    }
  }
  if (ext === 'obj') {
    const loader = new OBJLoader()
    // Its materials, when a .mtl of the same name sits beside it.
    const mtl = url.replace(/\.obj$/i, '.mtl')
    try {
      const materials = await new MTLLoader().loadAsync(mtl)
      materials.preload()
      loader.setMaterials(materials)
    } catch {
      // No .mtl: plain grey.
    }
    return loader.loadAsync(url)
  }
  if (ext === 'fbx') return new FBXLoader().loadAsync(url)
  if (ext === 'stl') {
    const geometry = await new STLLoader().loadAsync(url)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.1 }))
  }
  throw new Error('Not a 3D format the viewer reads')
}

export function statsOf(model: THREE.Object3D): ModelStats {
  let vertices = 0
  let triangles = 0
  let meshes = 0
  const materials = new Set<THREE.Material>()
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    meshes++
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return
    vertices += pos.count
    triangles += Math.floor((mesh.geometry.index?.count ?? pos.count) / 3)
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m)
  })
  const box = new THREE.Box3().setFromObject(model)
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
  return { vertices, triangles, meshes, materials: materials.size, size: [size.x, size.y, size.z] }
}

/** Lights, and the camera placed to see the whole model from the front, a little above. */
function stage(model: THREE.Object3D, camera: THREE.PerspectiveCamera): { scene: THREE.Scene; target: THREE.Vector3; radius: number } {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 2.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(3, 5, 4)
  scene.add(sun)
  scene.add(model)
  const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere())
  const radius = sphere.radius || 1
  const target = sphere.center
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1
  camera.near = dist / 100
  camera.far = dist * 100
  camera.position.copy(target).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist))
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  return { scene, target, radius }
}

let thumbRenderer: THREE.WebGLRenderer | null = null

/** One render of the model for the gallery: a THUMB_PX square canvas. */
export async function renderThumb(url: string, name: string): Promise<HTMLCanvasElement> {
  const model = await loadModel(url, name)
  thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  thumbRenderer.setSize(THUMB_PX, THUMB_PX, false)
  const camera = new THREE.PerspectiveCamera(35, 1)
  const { scene } = stage(model, camera)
  thumbRenderer.setClearColor(0x000000, 0)
  thumbRenderer.render(scene, camera)
  const out = document.createElement('canvas')
  out.width = out.height = THUMB_PX
  out.getContext('2d')!.drawImage(thumbRenderer.domElement, 0, 0)
  dispose(model)
  return out
}

function dispose(model: THREE.Object3D) {
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose()
  })
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const dim = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2))

/** The viewer in the preview pane. */
export default function ModelPreview({ path, name }: { path: string; name: string }) {
  const { profile } = useNotes()
  const host = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wire, setWire] = useState(false)
  const [grid, setGrid] = useState(true)
  const view = useRef<{ wire: (on: boolean) => void; grid: (on: boolean) => void; reset: () => void } | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let live = true
    let cleanup = () => {}
    ;(async () => {
      const { url } = await api.fileTicket(profile, path, true)
      const model = await loadModel(url, name)
      if (!live) return dispose(model)
      setStats(statsOf(model))
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setPixelRatio(window.devicePixelRatio)
      el.appendChild(renderer.domElement)
      const camera = new THREE.PerspectiveCamera(35, 1)
      const { scene, target, radius } = stage(model, camera)
      const home = camera.position.clone()
      const helper = new THREE.GridHelper(radius * 4, 20, 0x5a606a, 0x3a3f46)
      helper.position.y = new THREE.Box3().setFromObject(model).min.y
      scene.add(helper)
      const controls = new OrbitControls(camera, renderer.domElement)
      controls.target.copy(target)
      controls.update()
      const draw = () => renderer.render(scene, camera)
      const resize = () => {
        const w = el.clientWidth
        const h = el.clientHeight
        renderer.setSize(w, h)
        camera.aspect = w / Math.max(1, h)
        camera.updateProjectionMatrix()
        draw()
      }
      controls.addEventListener('change', draw)
      const ro = new ResizeObserver(resize)
      ro.observe(el)
      resize()
      view.current = {
        wire: (on) => {
          model.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (mesh.isMesh) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) (m as THREE.MeshStandardMaterial).wireframe = on
          })
          draw()
        },
        grid: (on) => {
          helper.visible = on
          draw()
        },
        reset: () => {
          camera.position.copy(home)
          controls.target.copy(target)
          controls.update()
          draw()
        },
      }
      cleanup = () => {
        ro.disconnect()
        controls.dispose()
        dispose(model)
        renderer.dispose()
        renderer.domElement.remove()
      }
    })().catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
      view.current = null
      cleanup()
    }
  }, [profile, path, name])

  if (error) return <p className="preview-note">{error}</p>
  return (
    <div className="model-preview">
      <div className="model-bar">
        <button className={cx('icon-btn', wire && 'on')} aria-pressed={wire} title="Wireframe" aria-label="Wireframe" onClick={() => (setWire(!wire), view.current?.wire(!wire))}>
          <Box size={14} />
        </button>
        <button className={cx('icon-btn', grid && 'on')} aria-pressed={grid} title="Grid" aria-label="Grid" onClick={() => (setGrid(!grid), view.current?.grid(!grid))}>
          <Grid3x3 size={14} />
        </button>
        <button className="icon-btn" title="Reset view" aria-label="Reset view" onClick={() => view.current?.reset()}>
          <RotateCcw size={14} />
        </button>
        <span className="hint">Drag to turn · scroll to zoom · right-drag to pan</span>
      </div>
      <div ref={host} className="model-canvas" />
      {stats ? (
        <p className="model-stats" aria-label="Model statistics">
          {plural(stats.vertices, 'vertex', 'vertices')} · {plural(stats.triangles, 'triangle', 'triangles')} · {plural(stats.meshes, 'mesh', 'meshes')} · {plural(stats.materials, 'material', 'materials')} ·{' '}
          {stats.size.map(dim).join(' × ')}
        </p>
      ) : (
        <div className="preview-loading" />
      )}
    </div>
  )
}
