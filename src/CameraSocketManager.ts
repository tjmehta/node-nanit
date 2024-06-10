import { StartOptsType } from 'abstract-startable'
import WebSocketManager from './WebSocketManager'
import EventEmitter from 'events'
import { client as proto } from './proto/nanit'
import timeout from 'abortable-timeout'

export default class CameraSocketManager extends WebSocketManager {
  protected lastRequestId = 0
  private responseEmitter: EventEmitter = new EventEmitter()
  cameraUID: string

  constructor(
    cameraUID: string,
    opts: ConstructorParameters<typeof WebSocketManager>[2],
  ) {
    super(
      `wss://api.nanit.com/focus/cameras/${cameraUID}/user_connect`,
      undefined,
      opts,
    )
    this.cameraUID = cameraUID
  }

  protected async _start(opts?: StartOptsType): Promise<void> {
    await super._start(opts)
    const ws = await this.getConnectedWebSocket()

    ws.on('message', (data: Buffer) => {
      const response = proto.Response.decode(new Uint8Array(data))
      this.responseEmitter.emit(response.requestId.toString(), response)
    })
  }

  protected async _stop(): Promise<void> {
    this.ws?.removeAllListeners()
    this.responseEmitter.removeAllListeners()

    await super._stop()
  }

  protected generateRequestId(): number {
    return ++this.lastRequestId
  }

  async sendRequest<Response extends proto.Response>(
    request: proto.Request,
    { timeoutMs }: { timeoutMs: number } = { timeoutMs: 5000 },
  ): Promise<Response> {
    const controller = new AbortController()
    const ws = await this.getConnectedWebSocket()

    return Promise.race<Response>([
      timeout(timeoutMs, controller.signal).then(
        () => new Error('timeout'),
      ) as Promise<never>,
      // request promise
      new Promise<Response>((resolve, reject) => {
        const requestIdString = request.id.toString()

        // handle abort
        controller.signal.addEventListener('abort', () => {
          this.responseEmitter.removeAllListeners(requestIdString)
          reject(new Error('aborted'))
        })
        // handle response
        this.responseEmitter.once(requestIdString, resolve)

        // send request
        ws.send(proto.Request.encode(request).finish())
      }),
    ])
  }

  async requestStreaming(rtmpUrl: string): Promise<void> {
    const request = proto.Request.create({
      id: 1,
      type: proto.RequestType.PUT_STREAMING,
      streaming: proto.Streaming.create({
        id: proto.StreamIdentifier.MOBILE,
        status: proto.Streaming.Status.STARTED,
        rtmpUrl,
        attempts: this.generateRequestId(),
      }),
    })

    this.sendRequest(request)
  }
}
