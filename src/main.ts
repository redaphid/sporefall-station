import { HostSession } from './app/hostSession'
import { SIM_DT } from './game/types'
import { createKeyboard } from './input/keyboard'
import { createTouch, mergeInputs } from './input/touch'
import { pickClass } from './ui/classSelect'
import { createRenderer } from './render/renderer'
import { createHud } from './ui/hud'
import { createScreens } from './ui/screens'

const boot = async (): Promise<void> => {
  const mount = document.getElementById('app')!
  const uiMount = document.getElementById('ui')!
  const renderer = await createRenderer(mount)
  const hud = createHud(uiMount)
  const screens = createScreens(uiMount)

  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed')) || ((Math.random() * 0xffffffff) >>> 0)

  // ?class=thief skips the picker (handy for dev + headless screenshots)
  const classId = params.get('class') ?? (await pickClass(uiMount))

  let input = createKeyboard()
  if (navigator.maxTouchPoints > 0) input = mergeInputs(input, createTouch(uiMount))

  const session = new HostSession(seed, classId, input)
  renderer.setLevel(session.world.level)
  let currentLevel = session.world.level

  let acc = 0
  let last = performance.now()
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.25)
    acc += dt
    last = now
    while (acc >= SIM_DT) {
      session.tick()
      acc -= SIM_DT
    }
    const alpha = acc / SIM_DT
    const view = session.renderView()
    // Floor changed: rebuild the tile layer and snap the camera to the new spawn
    if (view.level !== currentLevel) {
      currentLevel = view.level
      renderer.setLevel(view.level)
    }
    if (view.self) {
      const px = view.self.prevPos.x + (view.self.pos.x - view.self.prevPos.x) * alpha
      const py = view.self.prevPos.y + (view.self.pos.y - view.self.prevPos.y) * alpha
      renderer.camera.follow(px, py, dt)
    }
    renderer.draw(view, alpha, dt)
    hud.update(view)
    screens.update(view)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void boot()
