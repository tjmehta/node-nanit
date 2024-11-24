declare module 'node-media-server/src/node_core_ctx.js' {
  import { EventEmitter } from 'events'

  interface Session {
    id: string
  }

  interface Publisher {
    id: string
  }

  interface Stat {
    inbytes: number
    outbytes: number
    accepted: number
  }

  const sessions: Map<string, Session>
  const publishers: Map<string, Publisher>
  const idlePlayers: Set<string>
  const nodeEvent: EventEmitter
  const stat: Stat

  export { sessions, publishers, idlePlayers, nodeEvent, stat }
}
