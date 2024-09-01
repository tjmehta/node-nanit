import AbstractStartable, {
  StartOptsType,
  StopOptsType,
} from 'abstract-startable'
import { IncomingMessage, ServerResponse } from 'http'
import NodeMediaServer from 'node-media-server'
import koa from 'koa'
import bodyParser from '@koa/bodyparser'
import Router from '@koa/router'
import { NanitAuthStatus } from '../index'
import { Server } from 'http'
import nanitManager, { NanitManager } from './nanitManager'
import assert from 'assert'
import envVar from 'env-var'
import { StatusCodeError } from 'simple-api-client'
import { CameraMessage, CameraMessageType } from '../validateBabyMessage'
import { Subscription } from 'rxjs'
import mqtt from 'async-mqtt'
const { get } = envVar

const HTTP_PORT = get('HTTP_PORT').default(3000).asPortNumber()
// should be externally accessible port
const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const RTMP_HTTP_PORT = get('RTMP_PORT').default(8000).asPortNumber()
const NANIT_EVENTS_POLLING_TYPES = get('NANIT_EVENTS_POLLING_TYPES')
  .default(`${CameraMessageType.MOTION},${CameraMessageType.SOUND}`)
  .asArray() as CameraMessageType[]
const NANIT_EVENTS_POLLING_INTERVAL = get('NANIT_EVENTS_POLLING_INTERVAL')
  .default(1000 * 20)
  .asIntPositive()
const MQTT_URL = get('MQTT_URL').required().asString()
const MQTT_USERNAME = get('MQTT_USERNAME').asString()
const MQTT_PASSWORD = get('MQTT_PASSWORD').asString()
const MQTT_PREFIX = get('MQTT_PREFIX').default('nanit').asString()

enum RtmpPublisherStatus {
  NONE = 'NONE',
  REQUESTED = 'REQUESTED',
  PUBLISHING = 'PUBLISHING',
  // below would be deleted
  // DONE = 'DONE',
  // ERROR = 'ERROR',
}

type RtmpPublisher = {
  status: RtmpPublisherStatus
  cameraUid: string
  rtmpUrl: string
  subscribers: string[]
}

class AppServer extends AbstractStartable {
  private rtmpPublishers = new Map<string, RtmpPublisher>()
  private cameraMessageSubscriptions = new Map<string, Subscription>()
  private nanitManager = nanitManager
  private mqtt: mqtt.AsyncMqttClient | null = null
  private httpServer: Server<
    typeof IncomingMessage,
    typeof ServerResponse
  > | null = null
  private nms: NodeMediaServer | null = null

  constructor() {
    super()
  }

  async _start(opts?: StartOptsType): Promise<void> {
    console.log('starting app server')
    this.mqtt = await mqtt.connectAsync(MQTT_URL, {
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
    })
    await this.startHttpServer()
    await this.startRtmpServer()
    const nanit = this.nanitManager.get()
    if (nanit.authStatus === NanitAuthStatus.AUTHED) {
      await this.startPollingCameraMessages()
    }
  }

  async _stop(opts?: StopOptsType): Promise<void> {
    console.log('stopping app server')
    this.stopPollingCameraMessages()
    await this.mqtt?.end()
    await new Promise<void>((resolve, reject) =>
      this.httpServer?.close((err) => {
        if (err) return reject(err)
        resolve()
      }),
    )
    this.nms?.stop()
    await this.stopStreamingAll()
    this.rtmpPublishers.clear()
  }

  private async startHttpServer() {
    const app = new koa()
    const router = new Router()

    app.on('error', (err: any, ctx: any) => {
      console.error('Server error:', err)
    })

    app.use(bodyParser())

    router.get('/', (ctx: any) => {
      console.log('[HTTP] GET /')

      const nanit = this.nanitManager.get()

      if (nanit.authStatus === NanitAuthStatus.NO_CREDENTIALS) {
        console.log('[HTTP] GET /: no credentials')
        // render a form that accepts user name and password
        ctx.body = `
<html>
  <body>
    <form method="post" action="/login">
      <label for="email">Email:</label>
      <input type="text" id="email" name="email">
      <label for="password">Password:</label>
      <input type="password" id="password" name="password">
      <button type="submit">Login</button>
    </form>
  </body>
</html>
`
        return
      }

      if (nanit.authStatus === NanitAuthStatus.HAS_CREDENTIALS) {
        console.log('[HTTP] GET /: logged in', { session: nanit.auth.session })
        ctx.body = `
<html>
  <body>
    <p>Credentials cached but not logged in ${nanit.email}</p>
    <form method="post" action="/login">
      <label for="email">Email:</label>
      <input type="text" id="email" name="email" value="${nanit.email}">
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" value="${nanit.password}">
      <button type="submit">Login</button>
    </form>
    <a href="/logout">Delete credentials</a>
  </body>
</html>
`
        return
      }

      if (nanit.authStatus === NanitAuthStatus.AUTHED) {
        console.log('[HTTP] GET /: logged in', { session: nanit.auth.session })
        ctx.body = `
<html>
  <body>
    <p>Logged in as ${nanit.email}</p>
    <a href="/logout">Logout</a>
  </body>
</html>
`
        return
      }
    })

    router.post('/login', async (ctx: any) => {
      // read email and password from the form
      const credentials = ctx.request.body
      console.log('[HTTP] POST /login', credentials)
      // login to nanit
      const nanit = await nanitManager.login(credentials)

      if (nanit.authStatus === NanitAuthStatus.MFA_REQUIRED) {
        console.log('[HTTP] POST /login: mfa required')
        // render a form that accepts mfa token
        ctx.body = `
<html>
  <body>
    <form method="post" action="/mfa">
      <label for="mfaCode">MFA Code:</label>
      <input type="text" id="mfaCode" name="mfaCode" inputmode="numeric" autocomplete="one-time-code">
      <button type="submit">Submit</button>
    </form>
  </body>
</html>
`
      } else {
        console.log('[HTTP] POST /login: logged in')
        ctx.body = 'Login successful'
        this.startPollingCameraMessages()
      }
    })

    router.post('/mfa', async (ctx: any) => {
      const { mfaCode } = ctx.request.body
      console.log('[HTTP] POST /mfa', { mfaCode })

      const nanit = this.nanitManager.get()
      const auth = nanit.auth

      assert(auth.status === NanitAuthStatus.MFA_REQUIRED, 'invalid auth state')

      await this.nanitManager.loginMfa(mfaCode)
      ctx.body = 'Login successful'
      this.startPollingCameraMessages()
    })

    router.get('/logout', async (ctx: any) => {
      console.log('[HTTP] GET /logout')
      await this.nanitManager.logout()
      ctx.body = 'Logout successful'
    })

    app.use(router.routes()).use(router.allowedMethods())

    return new Promise<void>((resolve) => {
      this.httpServer = app.listen(HTTP_PORT, () => {
        console.log(`HTTP server started on port ${HTTP_PORT}`)
        resolve()
      })
    })
  }

  private async startRtmpServer() {
    const nms = new NodeMediaServer({
      rtmp: {
        port: RTMP_PORT,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
      http: {
        port: RTMP_HTTP_PORT,
        mediaroot: './media',
        allow_origin: '*',
      },
    })

    nms.on('prePublish', (id, path, args) => {
      console.log(`[RTMP] prePublish ${path}`, { args })
      // Here you can implement logic similar to your Go version's publisher handling
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')
      const rtmpUrl = `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
      const state = this.rtmpPublishers.get(cameraUid)

      if (state != null) {
        this.rtmpPublishers.set(cameraUid, {
          ...state,
          status: RtmpPublisherStatus.PUBLISHING,
        })
      } else {
        this.rtmpPublishers.set(cameraUid, {
          status: RtmpPublisherStatus.PUBLISHING,
          cameraUid,
          rtmpUrl,
          subscribers: [id],
        })
      }
    })

    nms.on('donePublish', (id, path, args) => {
      console.log(`[RTMP] donePublish ${path}`, { args })
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')
      // Handle publisher disconnection
      this.rtmpPublishers.delete(cameraUid)
    })

    nms.on('prePlay', async (id, path, args) => {
      console.log(`[RTMP] prePlay ${path}`, { args })
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')
      const rtmpUrl = `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
      const state = this.rtmpPublishers.get(cameraUid)

      if (state != null) {
        // stream already requested
        state.subscribers.push(id)
        return
      }

      // stream not requested yet
      this.rtmpPublishers.set(cameraUid, {
        status: RtmpPublisherStatus.NONE,
        cameraUid,
        rtmpUrl,
        subscribers: [id],
      })

      /*
       * request streaming
       */
      try {
        await this.requestStreaming(id, path, cameraUid)
      } catch (err) {
        console.log(`[RTMP] prePlay ${path}: error`, { err })
        this.rtmpPublishers.delete(cameraUid)
        throw err
      }
    })

    nms.on('donePlay', async (id, path, args) => {
      console.log(`[RTMP] donePlay ${path}`, { args })
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')
      const rtmpUrl = `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
      // Handle subscriber disconnection

      const state = this.rtmpPublishers.get(cameraUid)

      if (state == null) return

      const subscribers = state.subscribers.filter((subId) => subId !== id)
      this.rtmpPublishers.set(cameraUid, {
        ...state,
        subscribers,
      })

      if (subscribers.length === 0) {
        await this.nanitManager.get().stopStreaming(cameraUid, rtmpUrl)
        this.rtmpPublishers.delete(cameraUid)
      }
    })

    this.nms = nms

    this.nms.run()
    console.log(`RTMP server started on port ${RTMP_PORT}`)
  }

  private async startPollingCameraMessages() {
    const nanit = this.nanitManager.get()
    const cameras = await nanit.getCameras()
    if (NANIT_EVENTS_POLLING_TYPES.length === 0) {
      console.log('[RTMP] no camera message types to poll')
      return
    }

    cameras.forEach((camera) => {
      const cameraUid = camera.uid
      const babyUid = camera.babyUid
      if (this.cameraMessageSubscriptions.has(camera.uid)) {
        console.log('[RTMP] camera message subscription already exists', {
          cameraUid,
        })
        return
      }

      const subscription = nanit
        .pollCameraMessages(
          babyUid,
          NANIT_EVENTS_POLLING_TYPES,
          NANIT_EVENTS_POLLING_INTERVAL,
        )
        .subscribe({
          next: (message) => {
            console.log('[RTMP] camera message', {
              cameraUid,
              babyUid,
              message,
            })
            const type = message.type
            this.mqtt?.publish(
              `${MQTT_PREFIX}/camera/${cameraUid}/${type.toLowerCase()}`,
              JSON.stringify(message),
            )
          },
          error: (err) => {
            console.log('[RTMP] camera message: error', {
              cameraUid,
              babyUid,
              err,
            })
            this.cameraMessageSubscriptions.delete(cameraUid)
          },
          complete: () => {
            console.log('[RTMP] camera message: complete', {
              cameraUid,
              babyUid,
            })
            this.cameraMessageSubscriptions.delete(cameraUid)
          },
        })

      this.cameraMessageSubscriptions.set(cameraUid, subscription)
    })
  }

  private stopPollingCameraMessages() {
    this.cameraMessageSubscriptions.forEach((subscription) =>
      subscription.unsubscribe(),
    )
  }

  private async stopStreamingAll() {
    const cameraUids = Array.from(this.rtmpPublishers.values()).map(
      (v) => v.cameraUid,
    )

    await Promise.all(
      cameraUids.map((cameraUid) => {
        const state = this.rtmpPublishers.get(cameraUid)
        if (state == null) return
        return this.nanitManager
          .get()
          .stopStreaming(state.cameraUid, state.rtmpUrl)
      }),
    )
  }

  private async requestStreaming(
    subId: string,
    path: string,
    cameraUid: string,
  ) {
    const nanit = this.nanitManager.get()
    const rtmpUrl = `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`

    assert(nanit.authStatus === NanitAuthStatus.AUTHED, 'invalid auth state')

    try {
      let cameras = await nanit.getCameras()
      const camera = cameras.find((camera) => camera.uid === cameraUid)

      console.log(`[RTMP] prePlay ${path}: camera found?`, { camera })
      assert(camera != null, `camera not found: ${cameraUid}`)

      console.log(`[RTMP] prePlay ${path}: requestStreaming`, { rtmpUrl })
      await nanit.requestStreaming(camera.uid, rtmpUrl)
      const state = this.rtmpPublishers.get(cameraUid)
      if (state != null) {
        state.status = RtmpPublisherStatus.REQUESTED
      } else {
        this.rtmpPublishers.set(cameraUid, {
          status: RtmpPublisherStatus.REQUESTED,
          cameraUid,
          rtmpUrl,
          subscribers: [subId],
        })
      }

      console.log(`[RTMP] prePlay ${path}: success`)
    } catch (err) {
      console.log(`[RTMP] prePlay ${path}: error`, { err })
      if (err instanceof StatusCodeError && err.status === 401) {
        this.nanitManager.refreshSession()
      }
      throw err
    }
  }
}

export default AppServer
