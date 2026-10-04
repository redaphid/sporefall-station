// Probe worker for `wrangler dev --remote`: the unmodified RoomDO relay plus the colo probe.
export { RoomDO } from '../../../src/worker/roomDO'

interface Env {
  ROOM: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/ws/')) {
      const room = decodeURIComponent(url.pathname.slice(4)) || 'default'
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request)
    }
    const trace = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()
    return Response.json({ workerRequestCfColo: (request.cf as { colo?: string } | undefined)?.colo, workerOutboundTrace: trace })
  },
}
