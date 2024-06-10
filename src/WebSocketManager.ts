import AbstractStartable, { StartOptsType } from 'abstract-startable'
import WS from 'ws'
import Deferred from 'p-defer'
import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'

export type WebSocket = WS
export type WebSocketOptions = WS.ClientOptions

export default class WebSocketManager extends AbstractStartable {
  private wsArgs: ConstructorParameters<typeof WS>
  ws: WebSocket | undefined | null

  constructor(...args: ConstructorParameters<typeof WS>) {
    super()
    this.wsArgs = args
  }

  protected async _start(opts?: StartOptsType): Promise<void> {
    if (this.ws != null) {
      if (this.ws.readyState === WebSocket.OPEN) return
      this.ws = null
    }

    // connect ws
    const deferred = Deferred()
    this.ws = new WS(...this.wsArgs)
    this.ws.on('error', (err: unknown) => {
      deferred.reject(err)
    })
    this.ws.on('close', () => {
      // cleanup ws
      this.stop()
    })
    this.ws.on('open', () => {
      deferred.resolve()
    })

    await deferred.promise
  }

  protected async _stop(): Promise<void> {
    if (this.ws == null) return
    if (this.ws.CLOSED) {
      this.ws = null
      return
    }

    const deferred = Deferred()
    this.ws.on('close', () => {
      deferred.resolve()
    })

    this.ws.close()

    await deferred.promise
  }

  private checkConnection = memoizeConcurrent(
    async (): Promise<WebSocket | null> => {
      if (this.ws == null) return null
      if (this.ws.readyState === WebSocket.OPEN) return this.ws

      return null
    },
  )

  getConnectedWebSocket = memoizeConcurrent(async (): Promise<WebSocket> => {
    const ws = await this.checkConnection()
    if (ws != null) return ws

    await this.start()
    BaseError.assert(
      this.ws != null,
      'unexpected: websocket could not be connected',
    )

    return this.ws!
  })
}
