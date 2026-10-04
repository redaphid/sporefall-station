import { expect, it } from "vitest";
import { walledRoom, worldFromRows } from "../game/testkit";
import { emptyInput, type InputCmd } from "../game/types";
import type { Transport, TransportEvent } from "../net/types";
import { NetClientSession } from "./netClient";
import { NetHostSession } from "./netHost";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

it("a guest that rejoins mid-run fires its pre-drop roll once, not twice", async () => {
  let toHost: (e: TransportEvent) => void = () => {};
  let toClient: (e: TransportEvent) => void = () => {};
  let hostPeer = "g1";
  let up = true;
  const base = {
    medium: "online" as const,
    maxPacket: 65536,
    start: async () => {},
    stop: async () => {},
  };
  const hostT: Transport = {
    ...base,
    role: "host",
    sendPacket: async (_p, bytes) => {
      if (up) toClient({ type: "data", peer: "host", bytes });
    },
    on: (h) => ((toHost = h), () => {}),
    peers: () => [hostPeer],
  };
  const clientT: Transport = {
    ...base,
    role: "client",
    reconnect: async () => {},
    sendPacket: async (_p, bytes) => {
      if (up) toHost({ type: "data", peer: hostPeer, bytes });
    },
    on: (h) => ((toClient = h), () => {}),
    peers: () => ["host"],
  };
  let t = 0;
  let rollAt = -1;
  const src = {
    sample: (): InputCmd => {
      t++;
      return { ...emptyInput(), roll: t === rollAt };
    },
  };
  const host = new NetHostSession(
    9,
    "Host",
    { sample: () => emptyInput() },
    hostT,
    "casual",
    () => 0,
    (seed, mode) =>
      worldFromRows(walledRoom(30, 10), { seed, mode, hostile: false }),
  );
  const client = new NetClientSession("Guest", src, clientT);
  const rolls: number[] = [];
  host.onTickInputs = (inputs) => {
    if (inputs.get(1)?.roll) rolls.push(host.world.tick);
  };
  toHost({ type: "peerConnected", peer: hostPeer });
  toClient({ type: "peerConnected", peer: "host" });
  await flush();
  host.beginGame();
  await flush();
  const play = async (n: number) => {
    for (let i = 0; i < n; i++) {
      client.tick();
      host.tick();
      await flush();
    }
  };
  await play(20);
  expect(client.phase).toBe("playing");
  rollAt = t + 2;
  await play(4); // roll sent and folded; drop right after
  expect(rolls.length).toBe(1);
  up = false;
  toHost({ type: "peerDisconnected", peer: hostPeer, reason: "error" });
  toClient({ type: "peerDisconnected", peer: "host", reason: "error" });
  await flush();
  expect(client.phase).toBe("reconnecting");
  await play(10);
  up = true;
  hostPeer = "g2";
  toHost({ type: "peerConnected", peer: hostPeer });
  toClient({ type: "peerConnected", peer: "host" });
  await flush();
  await play(20);
  expect(client.phase).toBe("playing");
  expect(rolls.length).toBe(1);
});
