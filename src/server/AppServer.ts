import AbstractStartable, {
  StartOptsType,
  StopOptsType,
} from 'abstract-startable'
import { IncomingMessage, ServerResponse } from 'http'
import NodeMediaServer from 'node-media-server'
import koa from 'koa'
import bodyParser from '@koa/bodyparser'
import Router from '@koa/router'
import { NanitAuthStatus } from '../Nanit'
import { Server } from 'http'
import nanitManager, { NanitManager } from './nanitManager'
import assert from 'assert'
import envVar from 'env-var'
import { CameraMessage, CameraMessageType } from '../validateBabyMessage'
import { Subscription } from 'rxjs'
import mqtt from 'async-mqtt'
import { CameraStreamManager } from './CameraStreamManager'
import promiseBackoff from 'promise-backoff'
const { get } = envVar

const HTTP_PORT = get('HTTP_PORT').default(3000).asPortNumber()
// should be externally accessible port
const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const RTMP_HTTP_PORT = get('RTMP_PORT').default(8000).asPortNumber()
const PLAY_TIMEOUT = get('PLAY_TIMEOUT')
  .default(1000 * 15)
  .asIntPositive()
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

function cameraRtmpUrl(cameraUid: string): string {
  return `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
}
function mqttTopic(cameraUid: string): string {
  return `${MQTT_PREFIX}/camera/${cameraUid}/events`
}

class AppServer extends AbstractStartable {
  // subId -> TimeoutId
  private retryimeoutIds = new Map<string, NodeJS.Timeout>()
  // cameraUid -> CameraStreamManager
  private cameraStreamManagers = new Map<string, CameraStreamManager>()
  // cameraUid -> Subscription
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
      await this.onLogin()
    }
  }

  async _stop(opts?: StopOptsType): Promise<void> {
    console.log('stopping app server')
    this.stopPollingCameraMessages()
    await new Promise<void>((resolve, reject) =>
      this.httpServer?.close((err) => {
        if (err) return reject(err)
        resolve()
      }),
    )
    await this.mqtt?.end()
    await this.stopStreamingAll()
    this.nms?.stop()
  }

  private async startHttpServer() {
    const app = new koa()
    const router = new Router()

    app.on('error', (err: any, ctx: any) => {
      console.error('Server error:', err)
    })

    app.use(bodyParser())

    router.get('/', async (ctx: any) => {
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
        const cameras = await nanit.getCameras()
        ctx.body = `
<html>
  <body>
    <p>Logged in as ${nanit.email}</p>
    <p>Camera RTMP URLs:</p>
    <ul>
      ${cameras
        .map((camera) => `<li>${cameraRtmpUrl(camera.uid)}</li>`)
        .join('\n')}
    </ul>
    <p>MQTT Topics (messages: ${NANIT_EVENTS_POLLING_TYPES.map(
      wrapInQuotes,
    ).join(', ')}):</p>
    ${
      NANIT_EVENTS_POLLING_TYPES.length === 0
        ? '<p>None of the types are set</p>'
        : ''
    }
    ${
      NANIT_EVENTS_POLLING_TYPES.length > 0
        ? [
            '<ul>',
            ...cameras.map(
              (camera) =>
                `\t<li key="${camera.uid}">${mqttTopic(camera.uid)}</li>`,
            ),
            '</ul>',
          ].join('\n')
        : ''
    }

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
        this.onLogin()
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
      this.onLogin()
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

  private async onLogin() {
    await this.startPollingCameraMessages()
  }

  private async addSubscriber(
    cameraUid: string,
    id: string,
    attempt: number = 0,
  ) {
    const cameraStreamManager =
      this.cameraStreamManagers.get(cameraUid) ??
      new CameraStreamManager(this.nanitManager, cameraUid)

    this.cameraStreamManagers.set(cameraUid, cameraStreamManager)

    await cameraStreamManager.addSubscriber(id)
  }

  private deleteSubscriber = async (id: string, cameraUid: string) => {
    const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)

    assert(cameraStreamManager, 'cameraStreamManager not found')

    // remove subscriber, and possibly stop the stream
    try {
      await cameraStreamManager.deleteSubscriber(id)
    } catch (err) {
      console.error('[AppServer] deleteSubscriber error', {
        id,
        cameraUid,
        err,
      })
    }
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
      console.log(`[RTMP] prePublish ${path}`, { id })
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')

      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)

      if (cameraStreamManager == null) {
        console.warn(`[RTMP] prePublish ${path}: unexpected!`, { id })
        return
      }

      cameraStreamManager.publish()
    })

    nms.on('donePublish', (id, path, args) => {
      console.log(`[RTMP] donePublish ${path}`, { id })
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')

      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)

      if (cameraStreamManager == null) {
        console.warn(`[RTMP] donePublish ${path}: unexpected!`, { id })
        return
      }

      cameraStreamManager.donePublish()
    })

    nms.on('prePlay', async (id, path, args) => {
      console.log(`[RTMP] prePlay ${path}`, { id })
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')
      let attempt = 0
      promiseBackoff<void>(
        {
          timeouts: [10, 20, 30],
        },
        async ({ retry }) => {
          attempt++
          try {
            console.log('[RTMP] prePlay: addSubscriber: attempt', {
              cameraUid,
              id,
              attempt,
            })
            await this.addSubscriber(cameraUid, id)
            console.log('[RTMP] prePlay: addSubscriber: success', {
              cameraUid,
              id,
              attempt,
            })
          } catch (err: any) {
            console.log('[RTMP] prePlay: addSubscriber: error', {
              err,
              cameraUid,
              id,
              attempt,
            })
            // retry all errors, including timeout
            return retry(err)
          }
        },
      )
    })

    // donePlay is called when the client is done playing
    nms.on('donePlay', (id, path) => {
      const cameraUid = path.split('/').pop() ?? ''
      assert(cameraUid, 'cameraUid required')
      console.log(`[RTMP] donePlay`, { cameraUid, id })

      this.deleteSubscriber(id, cameraUid)
        .then(() => {
          console.log('[RTMP] donePlay: deleteSubscriber: success', {
            cameraUid,
            id,
          })
        })
        .catch((err) => {
          console.log('[RTMP] donePlay: deleteSubscriber: error', {
            cameraUid,
            id,
            err,
          })
        })
    })

    this.nms = nms

    this.nms.run()
    console.log(`RTMP server started on port ${RTMP_PORT}`)
  }

  private async startPollingCameraMessages() {
    const nanit = this.nanitManager.get()
    const cameras = await nanit.getCameras()
    console.log('[RTMP] getCameras', {
      camerasUids: cameras.map((c) => c.uid),
      babyUids: cameras.map((c) => c.babyUid),
    })
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
              type: message.type,
            })
            // publish "SOUND" or "MOTION"
            const subId = 'EVENT'
            this.addSubscriber(cameraUid, subId)
              .then(() => {
                console.log('[RTMP] camera message: addSubscriber: success', {
                  cameraUid,
                })
              })
              .catch((err) => {
                console.log('[RTMP] camera message: addSubscriber: error', {
                  cameraUid,
                  err,
                })
              })
              .finally(() => {
                this.mqtt?.publish(
                  mqttTopic(cameraUid),
                  message.type.toUpperCase() as CameraMessageType,
                )
              })

            process.nextTick(() => this.deleteSubscriber(subId, cameraUid))
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
    this.cameraMessageSubscriptions.clear()
  }

  private async stopStreamingAll() {
    this.cameraStreamManagers.forEach((cameraStreamManager) => {
      cameraStreamManager.stopForever()
    })
    this.cameraStreamManagers.clear()
  }
}

export default AppServer

function wrapInQuotes(str: string): string {
  return `"${str}"`
}
