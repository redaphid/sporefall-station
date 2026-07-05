import { makeEntity } from './game/entity'
import { SIM_DT } from './game/types'
import { addEntity, createWorld, tickWorld, type World } from './game/world'
import { createKeyboard } from './input/keyboard'
import { createRenderer } from './render/renderer'
import type { InputCmd } from './game/types'

const boot = async (): Promise<void> => {
  const mount = document.getElementById('app')!
  const renderer = await createRenderer(mount)

  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed')) || 1

  const world: World = createWorld(seed, 1)
  const player = addEntity(world, makeEntity('player', 'player', world.level.spawn.x, world.level.spawn.y))
  player.playerCtl = {
    playerId: 0,
    classId: 'soldier',
    abilityCooldown: 0,
    inventory: [],
    cash: 0,
    crimeUntilTick: 0,
  }
  player.health = { hp: 100, max: 100, iframes: 0 }

  renderer.setLevel(world.level)

  const keyboard = createKeyboard()
  const inputs = new Map<number, InputCmd>()

  let acc = 0
  let last = performance.now()
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.25)
    acc += dt
    last = now
    while (acc >= SIM_DT) {
      inputs.set(0, keyboard.sample())
      tickWorld(world, inputs)
      acc -= SIM_DT
    }
    const alpha = acc / SIM_DT
    const p = world.byId.get(player.id)
    if (p) {
      const px = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha
      const py = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha
      renderer.camera.follow(px, py, dt)
    }
    renderer.draw(world.entities, alpha, dt)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void boot()
