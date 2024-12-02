import { WebSocket, ClientOptions as WebsocketClientOptions } from 'ws'
import onceFirstEvent from './utils/onFirstEvent'
import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'
import { StatusCodeError as SimpleApiClientStatusCodeError } from 'simple-api-client'

export const StatusCodeError = SimpleApiClientStatusCodeError

type WebSocketOpts = WebsocketClientOptions

type CameraSocketsManagerOpts = {
  handshakeTimeout: NonNullable<WebSocketOpts['handshakeTimeout']>
  headers?: WebSocketOpts['headers']
}

class CameraSocketsManagerError extends BaseError {}

export class CameraSocketsManager {
  private websockets: Map<string, WebSocket> = new Map()
  private opts: CameraSocketsManagerOpts

  constructor(opts: CameraSocketsManagerOpts) {
    this.opts = opts
  }

  static getSocketUrl(cameraUID: string): string {
    return `wss://api.nanit.com/focus/cameras/${cameraUID}/user_connect`
  }

  getCameraSocket = memoizeConcurrent(
    async (
      cameraUID: string,
      opts?: {
        headers: NonNullable<CameraSocketsManagerOpts['headers']>
      },
    ): Promise<WebSocket> => {
      if (opts != null) {
        this.opts = {
          ...this.opts,
          headers: opts.headers,
        }
      }

      let ws: WebSocket | null | undefined = this.websockets.get(cameraUID)

      if (ws != null) {
        if (ws.readyState === WebSocket.OPEN) {
          // ws exists and is open. all good, return it.
          return ws
        }
        if (ws.readyState === WebSocket.CONNECTING) {
          // ws exists and is connecting. probably good? return it.
          console.warn('[CameraSocketsManager] getCameraSocket: connecting')
          return ws
        }
        // ws exists and is closed or closing. delete it. fall through
        if (
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          const wsStringState =
            ws.readyState === WebSocket.CLOSED ? 'CLOSED' : 'CLOSING'
          console.warn(
            `[CameraSocketsManager] getCameraSocket: ${wsStringState}`,
          )
          await this.closeCameraSocket(cameraUID)
          ws = null
          // fall through
        }
      }

      // ws does not exist or closed, create a new one
      ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(
          CameraSocketsManager.getSocketUrl(cameraUID),
          {
            ...this.opts,
            followRedirects: true,
            maxRedirects: 3,
          },
        )
        // listen to connect or fail
        const removeListeners = onceFirstEvent(socket, {
          error: (err: unknown) => {
            cleanup()
            // @ts-ignore
            if (/Unexpected server response: 401/.test(err.message)) {
              const statusErr = StatusCodeError.wrap(
                err as Error,
                'unexpected status',
                {
                  expectedStatus: 200,
                  status: 401,
                  headers: this.opts.headers ?? {},
                  path: CameraSocketsManager.getSocketUrl(cameraUID),
                },
              )

              reject(statusErr)
              return
            }

            reject(
              CameraSocketsManagerError.wrap(
                err as Error,
                'socket open: error',
              ),
            )
          },
          close: () => {
            cleanup()
            reject(new CameraSocketsManagerError('socket open: closed'))
          },
          open: () => {
            // SUCCESS!
            cleanup()
            resolve(socket)
          },
        })
        // redundant timeout, twice as long, just in case
        const timeoutId = setTimeout(() => {
          cleanup()
          reject(new CameraSocketsManagerError('socket open: closed'))
        }, this.opts.handshakeTimeout * 1.5)

        function cleanup() {
          removeListeners()
          clearTimeout(timeoutId)
        }
      })

      return ws
    },
  )

  async closeCameraSocket(cameraUID: string) {
    const ws = this.websockets.get(cameraUID)

    if (!ws) return

    // if connecting, wait for it to connect
    if (ws.readyState === WebSocket.CONNECTING) {
      await this.getCameraSocket(cameraUID)
    }

    // delete ws and close it
    this.websockets.delete(cameraUID)
    if (ws.readyState === WebSocket.CLOSED) return
    if (ws.readyState === WebSocket.CLOSING) return

    await new Promise<void>((resolve, reject) => {
      const removeListeners = onceFirstEvent(ws, {
        close: () => {
          cleanup()
          resolve()
        },
      })

      // redundant timeout, twice as long, just in case
      const timeoutId = setTimeout(() => {
        cleanup()
        reject(new CameraSocketsManagerError('socket open: closed'))
      }, this.opts.handshakeTimeout * 1.5)

      // close
      ws.close()

      function cleanup() {
        removeListeners()
        clearTimeout(timeoutId)
      }
    })
  }
}
