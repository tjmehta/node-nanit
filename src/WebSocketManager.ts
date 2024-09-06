import AbstractStartable, { StartOptsType } from 'abstract-startable'
import WS from 'ws'
import Deferred from 'p-defer'
import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'
import { StatusCodeError as SimpleApiClientStatusCodeError } from 'simple-api-client'

export type WebSocketType = WS
export type WebSocketOptions = WS.ClientOptions
export const StatusCodeError = SimpleApiClientStatusCodeError

export default class WebSocketManager extends AbstractStartable {
  private wsArgs: ConstructorParameters<typeof WS>
  ws: WebSocketType | undefined | null
  headers: Headers

  constructor(...args: ConstructorParameters<typeof WS>) {
    super()
    this.wsArgs = args
    const headersParentArg = args.find(
      (arg) => typeof arg == 'object' && arg != null && 'headers' in arg,
    )
    // @ts-ignore
    this.headers = headersParentArg?.headers ?? {}
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
    this.ws.once('error', (err: unknown) => {
      console.error('WS: error', err)
      // @ts-ignore
      if (/Unexpected server response: 401/.test(err.message)) {
        const statusErr = StatusCodeError.wrap(
          err as Error,
          'unexpected status',
          {
            expectedStatus: 200,
            status: 401,
            headers: this.headers ?? {},
            path: this.wsArgs[0].toString(),
          },
        )
        deferred.reject(statusErr)
        return
      }
      deferred.reject(err)
    })
    this.ws.once('close', () => {
      console.log('WS: close')
      // cleanup ws
      this.stop()
    })
    this.ws.once('open', () => {
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
    if (this.ws.readyState === WS.CLOSED || this.ws.readyState === WS.CLOSING) {
      this.ws = null
      return
    }
    console.log('WS: stop')

    const deferred = Deferred()

    this.ws.removeAllListeners('open')
    this.ws.removeAllListeners('close')
    this.ws.removeAllListeners('error')
    setTimeout(() => {
      console.warn('WS: stop: timeout', { readyState: this.ws?.readyState })
      if (this.ws?.readyState === WS.CLOSING) {
        deferred.reject(new Error('WS: stop: timeout'))
      }
      deferred.resolve()
    }, 60 * 1000)
    this.ws.once('close', () => {
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
