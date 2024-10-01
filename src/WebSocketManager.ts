import AbstractStartable, { StartOptsType, state } from 'abstract-startable'
import WS from 'ws'
import memoizeConcurrent from 'memoize-concurrent'
import { StatusCodeError as SimpleApiClientStatusCodeError } from 'simple-api-client'
import onceFirstEvent from './utils/onFirstEvent'

export type WebSocketType = WS
export type WebSocketOptions = WS.ClientOptions
export const StatusCodeError = SimpleApiClientStatusCodeError

const DEFAULT_HANDSHAKE_TIMEOUT = 1000 * 30

export enum ReadyState {
  CONNECTING = WS.CONNECTING,
  OPEN = WS.OPEN,
  CLOSING = WS.CLOSING,
  CLOSED = WS.CLOSED,
}

type WSMStartOptsType = StartOptsType & {
  force?: boolean
}

export default class WebSocketManager extends AbstractStartable<WSMStartOptsType> {
  private wsArgs: ConstructorParameters<typeof WS>
  private handleClose: (() => void) | undefined | null
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

  protected async _start(opts?: WSMStartOptsType): Promise<void> {
    try {
      const url = this.wsArgs[0]
      await new Promise<void>((resolve, reject) => {
        console.log('WS: start', {
          url,
        })
        this.ws = new WS(...this.wsArgs)
        // handle error
        onceFirstEvent(this.ws, {
          error: (err: unknown) => {
            console.error('WS: start: ws error', {
              err,
              url,
            })
            reject(err)
          },
          open: () => {
            console.log('WS: start: open', {
              url,
            })
            resolve()
          },
        })
        // handle close
        this.ws.once(
          'close',
          (this.handleClose = () => {
            // expected close
            if (this.state === state.STOPPING || this.state === state.STOPPED) {
              console.log('WS: expected close?', {
                url,
                state: this.state,
              })
              reject(new Error('WS: expected close'))
              return
            }

            console.warn('WS: unexpected close', { url, state: this.state })
            if (this.state === state.STARTING) {
              reject(new Error('WS: unexpected close'))
              return
            }

            // this.state === state.STARTED
            this.stop({ force: true }).catch((err) => {
              console.error('WS: unexpected close: stop error', { err, url })
            })
          }),
        )
      })
    } catch (err) {
      this.ws = null
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
    console.log('WS: stop', { url: this.wsArgs[0], force })
    if (force) {
      const ws = this.ws
      this.ws = null
      ws?.close()
      return
    }
    const url = this.wsArgs[0]

    await new Promise<void>((resolve, reject) => {
      if (this.ws == null) {
        console.log('WS: stop: already gone', { url })
        return resolve()
      }

      // get handshakeTimeout and use it as closeTimeout
      let handshakeTimeout = DEFAULT_HANDSHAKE_TIMEOUT
      this.wsArgs.some((arg) => {
        if (
          arg != null &&
          typeof arg === 'object' &&
          'handshakeTimeout' in arg &&
          typeof arg.handshakeTimeout === 'number'
        ) {
          handshakeTimeout = arg.handshakeTimeout
        }
      })

      const timeoutId = setTimeout(() => {
        console.warn('WS: stop: timeout', {
          url,
          wsReadyState: this.ws?.readyState,
        })
        // force close
        this.ws = null
        resolve()
      }, handshakeTimeout)

      this.ws.once('close', () => {
        console.log('WS: stop: close', { url })
        clearTimeout(timeoutId)
        this.ws = null
        resolve()
      })

      this.ws.close()
    })

    this.ws = null
    console.log('WS: stop: done', { url })
  }

  getConnectedWebSocket = memoizeConcurrent(
    async (): Promise<WebSocketType> => {
      await this.start({ force: true })

      return this.ws!
    },
  )
}
