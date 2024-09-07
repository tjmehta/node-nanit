import { StartOptsType } from 'abstract-startable'
import WebSocketManager from './WebSocketManager'
import EventEmitter from 'events'
import { client as proto } from './proto/nanit'
import timeout from 'abortable-timeout'
import raceAbort from 'race-abort'
// import { Observable } from 'rxjs'
import memoizeConcurrent from 'memoize-concurrent'

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

  protected async _start(opts?: StartOptsType): Promise<void> {
    console.log('CameraSocketManager: _start', { cameraUID: this.cameraUID })
    await super._start(opts)
    await this.getConnectedWebSocketAndHandleMessage()
  }

  protected async _stop(): Promise<void> {
    console.log('CameraSocketManager: _stop', { cameraUID: this.cameraUID })
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

  getConnectedWebSocketAndHandleMessage = memoizeConcurrent(async () => {
    const ws = await this.getConnectedWebSocket()
    if (ws.listenerCount('message', this.handleMessage) === 0) {
      ws.on('message', this.handleMessage)
    }
    return ws
  })

  private handleMessage = (data: Buffer) => {
    const response = proto.Response.decode(new Uint8Array(data))
    console.log('CameraSocketManager: response', response)
    this.responseEmitter.emit(response.requestId.toString(), response)
  }

  async sendRequest<Response extends proto.Response>(
    request: proto.Request,
    { timeoutMs }: { timeoutMs: number } = { timeoutMs: this.requestTimeoutMs },
  ): Promise<Response> {
    const ws = await this.getConnectedWebSocketAndHandleMessage()
    const controller = new AbortController()
    const requestIdString = request.id.toString()

    return Promise.race<Response>([
      timeout(timeoutMs, controller.signal).then(() => {
        throw new Error('timeout')
      }) as Promise<never>,
      // request promise
      new Promise<Response>((resolve, reject) => {
        controller.signal.addEventListener('aborted', () =>
          this.responseEmitter.removeListener(requestIdString, resolve),
        )
        // handle response
        this.responseEmitter.once(requestIdString, resolve)
        // send request
        const message = proto.Message.create({
          type: proto.Message.Type.REQUEST,
          request,
        })
        ws.send(proto.Message.encode(message).finish(), (err) => {
          if (err != null) reject(err)
        })
      }),
    ]).finally(() => {
      controller.abort()
    })
  }

  startStreaming = memoizeConcurrent(async (rtmpUrl: string): Promise<{}> => {
    console.log('CameraSocketManager: startStreaming: rtmpUrl', {
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
    const res = await this.sendRequest(request)

    console.log('CameraSocketManager: startStreaming: request success', {
      cameraUID: this.cameraUID,
      rtmpUrl,
      res: res.toJSON(),
    })
    this.activeStreamUrls.add(rtmpUrl)

    return res.toJSON()
  })

  stopStreaming = memoizeConcurrent(async (rtmpUrl: string): Promise<{}> => {
    console.log('CameraSocketManager: stopStreaming: rtmpUrl', {
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
      console.warn('CameraSocketManager: stopStreaming: rtmpUrl not streaming')
      // fall through and stop anyway
    }
    this.activeStreamUrls.delete(rtmpUrl)

    const res = await this.sendRequest(request)
    console.log('CameraSocketManager: stopStreaming: request success', {
      cameraUID: this.cameraUID,
      rtmpUrl,
      res: res.toJSON(),
    })

    return res.toJSON()
  })
}
