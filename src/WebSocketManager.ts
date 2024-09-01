import AbstractStartable, { StartOptsType } from 'abstract-startable'
import WS from 'ws'
import Deferred from 'p-defer'
import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'

export type WebSocketType = WS
export type WebSocketOptions = WS.ClientOptions

export default class WebSocketManager extends AbstractStartable {
  private wsArgs: ConstructorParameters<typeof WS>
  ws: WebSocketType | undefined | null

  constructor(...args: ConstructorParameters<typeof WS>) {
    super()
    this.wsArgs = args
  }

  protected async _start(opts?: StartOptsType): Promise<void> {
    if (this.ws != null) {
      if (this.ws.readyState === WS.OPEN) {
        console.log('WS: start: already started', this.wsArgs)
        return
      }
      this.ws = null
    }
    console.log('WS: start', this.wsArgs)

    // connect ws
    const deferred = Deferred()
    this.ws = new WS(...this.wsArgs)
    this.ws.on('error', (err: unknown) => {
      console.error('WS: error', err)
      deferred.reject(err)
    })
    this.ws.on('close', () => {
      console.log('WS: close')
      // cleanup ws
      this.stop()
    })
    this.ws.on('open', () => {
      console.log('WS: open')
      deferred.resolve()
    })

    await deferred.promise
  }

  protected async _stop(): Promise<void> {
    if (this.ws == null) {
      console.log('WS: stop: already stopped')
      return
    }
    if (this.ws.CLOSED || this.ws.CLOSING) {
      this.ws = null
      return
    }
    console.log('WS: stop')

    const deferred = Deferred()
    this.ws.on('close', () => {
      deferred.resolve()
    })

    this.ws.close()

    await deferred.promise
  }

  private checkConnection = memoizeConcurrent(
    async (): Promise<WebSocketType | null> => {
      if (this.ws == null) return null
      if (this.ws.readyState === WS.OPEN) return this.ws

      return null
    },
  )

  getConnectedWebSocket = memoizeConcurrent(
    async (): Promise<WebSocketType> => {
      const ws = await this.checkConnection()
      if (ws != null) return ws

      await this.start()
      BaseError.assert(
        this.ws != null,
        'unexpected: websocket could not be connected',
      )

      return this.ws!
    },
  )
}
