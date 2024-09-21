import { StartOptsType, state, StopOptsType } from 'abstract-startable'
import WebSocketManager, { ReadyState, WebSocketType } from './WebSocketManager'
import EventEmitter from 'events'
import { client as proto } from './proto/nanit'
import memoizeConcurrent from 'memoize-concurrent'
import BaseError from 'baseerr'

type CameraSocketManagerOpts = {
  ws: ConstructorParameters<typeof WebSocketManager>[2]
  requestTimeoutMs: number
}
export default class CameraSocketManager extends WebSocketManager {
  protected lastRequestId = 0
  private responseEmitter: EventEmitter = new EventEmitter()
  activeStreamUrls = new Set<string>()
  cameraUID: string
  requestTimeoutMs: number

  constructor(cameraUID: string, opts: CameraSocketManagerOpts) {
    super(
      `wss://api.nanit.com/focus/cameras/${cameraUID}/user_connect`,
      undefined,
      opts.ws,
    )
    this.cameraUID = cameraUID
    this.requestTimeoutMs = opts.requestTimeoutMs
  }

  private handleMessages = () => {
    BaseError.assert(this.ws != null, 'ws not connected')
    const ws = this.ws
    if (ws.listenerCount('message', this.handleMessage) === 0) {
      ws.on('message', this.handleMessage)
    }
  }

  protected async _start(opts?: StartOptsType): Promise<void> {
    console.log('[SocketManager] _start', { cameraUID: this.cameraUID })
    await super._start(opts)
    this.handleMessages()
    console.log('[SocketManager] _start: super _start success', {
      cameraUID: this.cameraUID,
    })
  }

  protected async _stop(opts?: StopOptsType): Promise<void> {
    console.log('[SocketManager] _stop', { cameraUID: this.cameraUID })
    await Promise.all(
      [...this.activeStreamUrls].map((rtmpUrl) => this.stopStreaming(rtmpUrl)),
    )
    this.ws?.removeAllListeners('message')
    this.responseEmitter.removeAllListeners()

    await super._stop()
  }

  protected generateRequestId(): number {
    return ++this.lastRequestId
  }

  getConnectedWebSocketAndHandleMessage = memoizeConcurrent(
    async (): Promise<WebSocketType> => {
      console.log('[SocketManager] getConnectedWebSocketAndHandleMessage', {
        cameraUID: this.cameraUID,
        hasWs: this.ws != null,
        wsReadyState: this.ws?.readyState,
      })
      const ws = await this.getConnectedWebSocket()
      this.handleMessages()
      return ws
    },
  )

  private handleMessage = (data: Buffer) => {
    const response = proto.Response.decode(new Uint8Array(data))
    console.log('[SocketManager] response', response)
    this.responseEmitter.emit(response.requestId.toString(), response)
  }

  async sendRequest<Response extends proto.Response>(
    request: proto.Request,
    { timeoutMs, autoConnect }: { timeoutMs: number; autoConnect: boolean } = {
      timeoutMs: this.requestTimeoutMs,
      autoConnect: true,
    },
  ): Promise<Response> {
    let ws: WebSocketType

    if (autoConnect) {
      ws = await this.getConnectedWebSocketAndHandleMessage()
    } else {
      BaseError.assert(this.ws != null, 'ws missing')
      BaseError.assert(
        this.state != state.STOPPING && this.state != state.STOPPED,
        'wsm not started',
        {
          hasWs: this.ws != null,
          wsReadyState: this.ws?.readyState,
        },
      )
      if (this.state != state.STARTING) {
        await this.start()
      }
      ws = this.ws!
    }

    const self = this
    const requestIdString = request.id.toString()

    return new Promise<Response>((resolve, reject) => {
      // race timeout
      const timeoutId = setTimeout(onTimeout, timeoutMs)

      // send request
      const message = proto.Message.create({
        type: proto.Message.Type.REQUEST,
        request,
      })
      this.responseEmitter.once(requestIdString, onResponse)
      ws.send(proto.Message.encode(message).finish(), (err) => {
        if (err != null) reject(err)
      })

      // handlers
      function onTimeout() {
        // request timeout
        self.responseEmitter.removeListener(requestIdString, onResponse)
        reject(new Error('timeout'))
      }
      function onResponse(res: Response) {
        // request success
        clearTimeout(timeoutId)
        resolve(res)
      }
    })
  }

  startStreaming = memoizeConcurrent(async (rtmpUrl: string): Promise<{}> => {
    console.log('[SocketManager] startStreaming: rtmpUrl', {
      cameraUID: this.cameraUID,
      rtmpUrl,
    })

    const request = proto.Request.create({
      id: this.generateRequestId(),
      type: proto.RequestType.PUT_STREAMING,
      streaming: proto.Streaming.create({
        id: proto.StreamIdentifier.MOBILE,
        status: proto.Streaming.Status.STARTED,
        rtmpUrl,
        attempts: 1,
      }),
    })
    const res = await this.sendRequest(request, {
      timeoutMs: this.requestTimeoutMs,
      autoConnect: true,
    })

    console.log('[SocketManager] startStreaming: request success', {
      cameraUID: this.cameraUID,
      rtmpUrl,
      res: res.toJSON(),
    })
    this.activeStreamUrls.add(rtmpUrl)

    return res.toJSON()
  })

  stopStreaming = memoizeConcurrent(async (rtmpUrl: string): Promise<{}> => {
    console.log('[SocketManager] stopStreaming: rtmpUrl', {
      cameraUID: this.cameraUID,
      rtmpUrl,
    })

    const request = proto.Request.create({
      id: this.generateRequestId(),
      type: proto.RequestType.PUT_STREAMING,
      streaming: proto.Streaming.create({
        id: proto.StreamIdentifier.MOBILE,
        status: proto.Streaming.Status.STOPPED,
        rtmpUrl,
        attempts: 1,
      }),
    })

    if (!this.activeStreamUrls.has(rtmpUrl)) {
      console.warn('[SocketManager] stopStreaming: rtmpUrl not streaming')
      // fall through and stop anyway
    }
    this.activeStreamUrls.delete(rtmpUrl)
    try {
      const res = await this.sendRequest(request, {
        timeoutMs: this.requestTimeoutMs,
        autoConnect: false,
      })
      console.log('[SocketManager] stopStreaming: request success', {
        cameraUID: this.cameraUID,
        rtmpUrl,
        res: res.toJSON(),
      })

      return res.toJSON()
    } catch (err) {
      console.warn('[SocketManager] stopStreaming: request error', {
        cameraUID: this.cameraUID,
        rtmpUrl,
        err,
      })
      return {}
    }
  })
}
