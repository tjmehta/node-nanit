import AbstractStartable, {
  StartOptsType,
  state,
  StopOptsType,
} from 'abstract-startable'
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

  async start(opts?: WSMStartOptsType): Promise<void> {
    if (this.state === state.STARTED) return
    if (this.state === state.STARTING) return this.startPromise
    if (this.state === state.STOPPING) {
      if (opts?.force) {
        // stop and start immediately
        return this.stop({ force: true }).then(() => super.start(opts))
      }
      return Promise.reject(
        new Error('cannot start server, server is stopping'),
      )
    }
    // this.state === state.STOPPED
    this.startPromise = this._start(opts)
      .catch((err) => {
        delete this.startPromise
        throw err
      })
      .then(() => {
        this.started = true
        delete this.startPromise
        if (this.state === state.STOPPING) {
          throw new Error('server started successfully, but is stopping now')
        }
      })
    return this.startPromise
  }

  protected async _start(opts?: WSMStartOptsType): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        console.log('WS: start', this.wsArgs)
        this.ws = new WS(...this.wsArgs)
        // handle error
        onceFirstEvent(this.ws, {
          error: (err: unknown) => {
            console.error('WS: start: ws error', err)
            reject(err)
          },
          open: () => {
            console.log('WS: start: open')
            resolve()
          },
        })
        // handle close
        this.ws.once(
          'close',
          (this.handleClose = () => {
            // expected close
            if (this.state === state.STOPPING || this.state === state.STOPPED) {
              return
            }

            console.warn('WS: unexpected close', { state: this.state })
            if (this.state === state.STARTING) {
              reject(new Error('WS: unexpected close'))
              return
            }

            // this.state === state.STARTED
            this.stop({ force: true }).catch((err) => {
              console.error('WS: unexpected close: stop error', err)
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

  async stop(opts?: StopOptsType): Promise<void> {
    if (this.state === state.STOPPED) return
    if (this.state === state.STOPPING) {
      if (opts?.force) {
        this.ws = null
        return
      }
      return this.stopPromise
    }
    // this.state === state.STARTING
    // this.state === state.STARTED
    if (this.state === state.STARTING) {
      if (opts?.force) {
        this.ws?.close()
        this.ws = null
        return
      }
      return super.stop(opts)
    }

    return super.stop(opts)
  }

  protected async _stop(
    { force }: { force?: boolean } = { force: false },
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.ws == null) {
        console.log('WS: stop: already gone')
        return resolve()
      }

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
        console.warn('WS: stop: timeout', { readyState: this.ws?.readyState })
        // force close
        this.ws = null
        resolve()
      }, handshakeTimeout)

      this.ws.once('close', () => {
        clearTimeout(timeoutId)
        this.ws = null
        resolve()
      })

      this.ws.close()
    })

    this.ws = null
    console.log('WS: stop: done')
  }

  getConnectedWebSocket = memoizeConcurrent(
    async (): Promise<WebSocketType> => {
      await this.start({ force: true })

      return this.ws!
    },
  )
}
