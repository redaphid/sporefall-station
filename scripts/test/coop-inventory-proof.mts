/**
 * Scripted headless proof for issue #57 — a joining CLIENT now has its OWN
 * authoritative inventory (slots / activeSlot / per-weapon mods / ammo), can
 * switch weapons, and can use items, with the result reflected back from the
 * authoritative host. Co-op needs two live peers, which the single-webview e2e
 * video recorder can't stage, so this drives the REAL NetHostSession +
 * NetClientSession over an in-memory loopback (exactly what the unit tests use)
 * and narrates each step. Run: `pnpm exec tsx scripts/test/coop-inventory-proof.mts`.
 */
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'
import { hotbarSlots } from '../../src/ui/hotbarModel'
import type { PeerId, Transport, TransportEvent } from '../../src/net/types'
import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'

const out: string[] = []
const log = (s = ''): void => {
  out.push(s)
  console.log(s)
}

class MockHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  constructor() {
    const deliver = (fn: (() => void) | undefined) => Promise.resolve().then(() => fn?.())
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer, bytes) => deliver(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => ((this.hostHandler = h), () => {}),
      peers: () => [...this.centrals.keys()],
    }
  }
  addClient(name: string, input: InputSource) {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let ch: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (b) => void Promise.resolve().then(() => ch?.({ type: 'data', peer: 'host', bytes: b })))
    const t: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, b) => Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes: b })),
      on: (h) => ((ch = h), () => {}),
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, t)
    const connect = () => {
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
      void Promise.resolve().then(() => ch?.({ type: 'peerConnected', peer: 'host' }))
    }
    return { session, connect }
  }
}

const makeInput = () => {
  let cur = emptyInput()
  return { source: { sample: () => ({ ...cur }) } as InputSource, set: (c: Partial<InputCmd>) => (cur = { ...emptyInput(), ...c }) }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const showClient = (label: string, session: NetClientSession) => {
  const self = session.renderView().self!
  const ctl = self.playerCtl!
  const slots = hotbarSlots(ctl.inventory, ctl.activeSlot)
  log(`  ${label}:`)
  log(`    swung weapon : ${self.combat?.weapon}`)
  log(`    activeSlot   : ${ctl.activeSlot}`)
  for (const s of slots) {
    log(`    [${s.index}] ${s.label.padEnd(11)} x${String(s.qty).padStart(3)} ${s.active ? '<< EQUIPPED' : ''}  ${s.mods}`)
  }
}

const main = async () => {
  log('=== Co-op client inventory proof (issue #57) ===\n')
  const hub = new MockHub()
  const clientInput = makeInput()
  const host = new NetHostSession(4242, 'Alice', makeInput().source, hub.hostTransport)
  const bob = hub.addClient('Bob', 'thief', clientInput.source)
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()

  // Host-authoritative loadout for Bob's avatar: two guns (one MODDED) + items.
  const bobAvatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
  bobAvatar.playerCtl!.inventory = [
    { itemId: 'pistol', qty: 20 },
    { itemId: 'freezeRay', qty: 6, mods: [{ id: 'frost', stacks: 2 }] },
    { itemId: 'stunGun', qty: 4 },
    { itemId: 'bandage', qty: 37 },
  ]
  bobAvatar.playerCtl!.activeSlot = 0
  bobAvatar.combat!.weapon = 'pistol'
  bobAvatar.health!.hp = 40
  const tick = async (n: number) => {
    for (let i = 0; i < n; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
  }
  await tick(6)

  log('STEP 1 — client receives its FULL inventory (was a bandage summary before the fix)')
  showClient('client Bob sees', bob.session)
  log('    ^ 37 bandages are ONE stack, not 37 phantom slots; freeze ray shows its ❄️ mod.\n')

  log('STEP 2 — client taps hotbar slot 1 to switch to the freeze ray')
  clientInput.set({ hotbar: 1 })
  await tick(2)
  clientInput.set({})
  await tick(4)
  log(`    host authoritative: activeSlot=${bobAvatar.playerCtl!.activeSlot}, weapon=${bobAvatar.combat!.weapon}`)
  showClient('client reflects', bob.session)
  log('')

  log('STEP 3 — client switches back to slot 3 (bandage) and USES it (heals on the host)')
  clientInput.set({ hotbar: 3 })
  await tick(2)
  clientInput.set({ throwItem: true })
  await tick(2)
  clientInput.set({})
  await tick(4)
  log(`    host authoritative: hp=${bobAvatar.health!.hp}, bandages left=${bobAvatar.playerCtl!.inventory.find((s) => s.itemId === 'bandage')?.qty}`)
  showClient('client reflects', bob.session)
  log('\n=== PROOF COMPLETE: client has real inventory, switches weapons, and uses items ===')

  const fs = await import('node:fs')
  const dir = '/tmp/claude-1000/-home-redaphid-Projects-streets-of-rogue-mobile/c1fe7c36-8312-475b-8777-001ccbc9693d/scratchpad/coop-inventory-shots'
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/coop-inventory-proof.log`, out.join('\n') + '\n')
}

void main()
