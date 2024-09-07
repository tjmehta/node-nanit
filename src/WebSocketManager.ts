import AbstractStartable, { StartOptsType, state } from 'abstract-startable'
import WS from 'ws'
import memoizeConcurrent from 'memoize-concurrent'
import { StatusCodeError as SimpleApiClientStatusCodeError } from 'simple-api-client'

export type WebSocketType = WS
export type WebSocketOptions = WS.ClientOptions
export const StatusCodeError = SimpleApiClientStatusCodeError

export enum ReadyState {
  CONNECTING = WS.CONNECTING,
  OPEN = WS.OPEN,
  CLOSING = WS.CLOSING,
  CLOSED = WS.CLOSED,
}

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
    console.log('WS: start', this.wsArgs)

    // connect ws
    try {
      await new Promise<void>((resolve, reject) => {
        this.ws = new WS(...this.wsArgs)
        this.ws.once('error', (err: unknown) => {
          console.error('WS: start: ws error', err)
          this.ws = null
          reject(err)
        })
        this.ws.once('close', () => {
          if (this.state === state.STOPPING || this.state === state.STOPPED) {
            // expected close
            return
          }

          console.warn('WS: unexpected close', { state: this.state })

          if (this.state === state.STARTING) {
            this.ws = null
            reject(new Error('WS: unexpected close'))
            return
          }

          // this.state === state.STARTED
          this.stop({ force: true }).catch((err) => {
            console.error('WS: unexpected close: stop error', err)
          })
        })
        this.ws.once('open', () => {
          console.log('WS: start: open')
          resolve()
        })
      })
    } catch (err) {
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

        throw statusErr
      }
    }
  }

  protected async _stop(
    { force }: { force?: boolean } = { force: false },
  ): Promise<void> {
    console.log('WS: stop')
    return new Promise<void>((resolve, reject) => {
      if (this.ws == null) {
        console.log('WS: stop: already stopped')
        return resolve()
      }

      if (
        force ||
        this.ws.readyState === WS.CLOSED ||
        this.ws.readyState === WS.CLOSING
      ) {
        console.log('WS: stop: force', {
          state: this.state,
          readyState: this.ws?.readyState,
        })
        this.ws = null
        return resolve()
      }

      this.ws.removeAllListeners('open')
      this.ws.removeAllListeners('close')
      this.ws.removeAllListeners('error')

      const timeoutId = setTimeout(() => {
        console.warn('WS: stop: timeout', { readyState: this.ws?.readyState })
        // force close
        this.ws = null
        resolve()
      }, 60 * 1000)

      this.ws.once('close', () => {
        clearTimeout(timeoutId)
        this.ws = null
        resolve()
      })

      this.ws.close()
    })
  }

  getConnectedWebSocket = memoizeConcurrent(
    async (): Promise<WebSocketType> => {
      if (this.state == state.STOPPING || this.state == state.STOPPED) {
        await this.stop()
        await this.start()
      } else if (this.state == state.STARTING) {
        await this.start()
      }

      return this.ws!
    },
  )
}
