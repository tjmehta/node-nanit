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
import envVar from 'env-var'
import { CameraMessageType } from '../validateBabyMessage'
import { Subscription, tap, throttleTime } from 'rxjs'
import mqtt from 'async-mqtt'
import { CameraStreamManager } from '../CameraStreamManager'
import EventEmitter from 'events'
import context from 'node-media-server/src/node_core_ctx.js'
import BaseError from 'baseerr'

class AppServerError extends BaseError {}

const { get } = envVar

class TempCache<ValueType = string> {
  private cache = new Map<
    string,
    { value: ValueType; timeoutId: NodeJS.Timeout }
  >()
  private storageTime: number

  constructor(storageTime: number) {
    this.storageTime = storageTime
  }

  set(key: string, value: ValueType) {
    const { timeoutId: previousTimeoutId } = this.cache.get(key) ?? {}
    if (previousTimeoutId) clearTimeout(previousTimeoutId)

    const timeoutId = setTimeout(() => {
      this.cache.delete(key)
    }, this.storageTime)
    this.cache.set(key, { value, timeoutId })
  }

  get(key: string): ValueType | undefined {
    return this.cache.get(key)?.value
  }
}
const sessionIdToPathCache = new TempCache<string>(1000 * 60 * 5)

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

function cameraRtmpUrl(cameraUid: string): string {
  return `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
}
function mqttTopic(cameraUid: string): string {
  return `${MQTT_PREFIX}/camera/${cameraUid}/events`
}
function normalizePath(path: string): string {
  if (path.length === 0) return path // noop
  // remove trailing slash
  if (path.charAt(path.length - 1) === '/') return path.slice(0, -1)
  // noop
  return path
}

class AppServer extends AbstractStartable {
  // subId -> TimeoutId
  private retryimeoutIds = new Map<string, NodeJS.Timeout>()
  // cameraUid -> CameraStreamManager
  private cameraStreamManagers = new Map<string, CameraStreamManager>()
  // cameraUid -> Subscription
  private cameraMessageSubscriptions = new Map<
    string,
    { subscription: Subscription; ee: EventEmitter }
  >()
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
    <p>MQTT Debugging:</p>
    <ul>
      ${cameras
        .map(
          (camera) =>
            `<li><a href="/cameras/${camera.uid}/events">/cameras/${camera.uid}/events</a></li>`,
        )
        .join('\n')}
    </ul>

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

      AppServerError.assert(
        auth.status === NanitAuthStatus.MFA_REQUIRED,
        'invalid auth state',
        { status: auth.status },
      )

      await this.nanitManager.loginMfa(mfaCode)
      ctx.body = 'Login successful'
      this.onLogin()
    })

    router.get('/cameras/:cameraUid/events', async (ctx: any) => {
      const { cameraUid } = ctx.params
      const subState = this.cameraMessageSubscriptions.get(cameraUid)
      if (!subState) {
        ctx.body = 'Camera not found'
        return
      }
      const { ee } = subState
      ctx.body = `
<html>
  <body>
    <script>
    function submitForm(event, cameraUid, type) {
      event.preventDefault();
      fetch(\`/cameras/\${cameraUid}/events/\${type}\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      .then(response => response.json())
      .then(data => console.log('Success:', data))
      .catch((error) => alert('Error:' + error.message));
    }
    </script>
    <p>MQTT Topics (messages: ${NANIT_EVENTS_POLLING_TYPES.map(
      wrapInQuotes,
    ).join(', ')}):</p>
    ${
      NANIT_EVENTS_POLLING_TYPES.length === 0
        ? '<p>None of the types are set</p>'
        : ''
    }
    ${NANIT_EVENTS_POLLING_TYPES.map((type) => {
      return [
        `<form id="form-${type}" onsubmit="submitForm(event, '${cameraUid}', '${type}')">`,
        `<p key="${cameraUid}">/cameras/${cameraUid}/events/${type}</p>`,
        `<button type="submit">Trigger ${type}</button>`,
        '</form>',
      ].join('\n')
    }).join('\n')}
  </body>
</html>
`
    })

    router.post('/cameras/:cameraUid/events/:type', async (ctx: any) => {
      const { cameraUid, type } = ctx.params
      console.log('[HTTP] POST /cameras/:cameraUid/events/:type', {
        cameraUid,
        type,
      })
      const subState = this.cameraMessageSubscriptions.get(cameraUid)
      if (!subState) {
        ctx.body = 'Camera not found'
        return
      }
      const upperType = type.toUpperCase() as CameraMessageType
      if (!NANIT_EVENTS_POLLING_TYPES.includes(upperType)) {
        ctx.body = 'Invalid event type'
        return
      }

      const { ee } = subState

      ee.emit('testMessage', {
        id: 22690834345,
        babyUID: '5871f4ab',
        userId: 393085,
        type: upperType as CameraMessageType,
        time: Math.floor(Date.now() / 1000),
        readAt: null,
        seenAt: null,
        dismissedAt: null,
        updatedAt: new Date(),
        createdAt: new Date().toISOString(),
      })

      ctx.body = 'Event triggered'
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

    /* STREAM EVENTS */

    nms.on('prePublish', (id, path, args) => {
      const normalizedPath = normalizePath(path)
      const cameraUid = normalizedPath.split('/').pop() ?? ''
      AppServerError.assert(cameraUid, 'cameraUid required', {
        path,
        id,
        cameraUid,
      })
      console.log(`[RTMP] prePublish ${path}`, {
        cameraUid,
        id,
        date: Date.now(),
      })

      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)

      if (cameraStreamManager == null) {
        console.warn(`[RTMP] prePublish ${path}: unexpected!`, {
          cameraUid,
          id,
          date: Date.now(),
        })
        return
      }

      cameraStreamManager.streamPublishing()
    })

    // nms.on('postPublish', (id, path, args) => {
    //   const normalizedPath = normalizePath(path)
    //   const cameraUid = normalizedPath.split('/').pop() ?? ''
    //   AppServerError.assert(cameraUid, 'cameraUid required', {
    //     path,
    //     id,
    //     cameraUid,
    //   })
    //   console.log(`[RTMP] postPublish ${path}`, {
    //     cameraUid,
    //     id,
    //     date: Date.now(),
    //   })
    // })

    nms.on('donePublish', (id, path, args) => {
      const normalizedPath = normalizePath(path)
      const cameraUid = normalizedPath.split('/').pop() ?? ''
      AppServerError.assert(cameraUid, 'cameraUid required', {
        path,
        id,
        cameraUid,
      })
      console.log(`[RTMP] donePublish ${path}`, {
        cameraUid,
        id,
        date: Date.now(),
      })

      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)

      if (cameraStreamManager == null) {
        console.warn(`[RTMP] donePublish ${path}: unexpected!`, {
          cameraUid,
          id,
          date: Date.now(),
        })
        return
      }

      cameraStreamManager.streamDonePublishing()
    })

    /* SUBSCRIBER EVENTS */

    // nms.on('preConnect', async (id, path, args) => {
    //   this.onPrePlay('preConnect', id, path, args)
    // })

    nms.on('prePlay', async (id: string, path: string, args: any) => {
      const label = 'prePlay'
      const normalizedPath = normalizePath(path)
      const cameraUid = normalizedPath.split('/').pop() ?? ''

      AppServerError.assert(cameraUid, 'cameraUid required', {
        path,
        id,
        cameraUid,
      })

      console.log(`[RTMP] ${label} ${path}`, { cameraUid, id })
      // used in doneConnect
      sessionIdToPathCache.set(id, path)

      try {
        console.log(`[RTMP] ${label}: addSubscriber:`, {
          cameraUid,
          id,
          date: Date.now(),
        })
        const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)
        await cameraStreamManager!.addSubscriber(id)
        console.log(`[RTMP] ${label}: addSubscriber: success`, {
          cameraUid,
          id,
          date: Date.now(),
        })

        // TODO: maybe you can handle this properly now with all the rtmp events
        setTimeout(() => {
          // check if sub is idle
          const sessionIsIdle = context.idlePlayers.has(id)

          if (!sessionIsIdle) return

          // sub is idle
          console.log(`[RTMP] ${label}: session is idle`, {
            cameraUid,
            id,
          })
          cameraStreamManager!
            .deleteSubscriber(id)
            .then(() => {
              console.log(
                `[RTMP] ${label}: session is idle: deleteSubscriber: success`,
                {
                  cameraUid,
                  id,
                  date: Date.now(),
                },
              )
            })
            .catch((err) => {
              console.log(
                `[RTMP] ${label}: session is idle: deleteSubscriber: error`,
                {
                  cameraUid,
                  id,
                  date: Date.now(),
                  err,
                },
              )
            })
        }, 200)
      } catch (err: any) {
        console.log(`[RTMP] ${label}: addSubscriber: error`, {
          err,
          cameraUid,
          id,
          date: Date.now(),
        })
      }
    })

    nms.on('postPlay', (id, path, args) => {
      // only happens on successful play
      const normalizedPath = normalizePath(path)
      const cameraUid = normalizedPath.split('/').pop() ?? ''

      AppServerError.assert(cameraUid, 'cameraUid required', {
        path,
        id,
        cameraUid,
      })
      // used in doneConnect
      sessionIdToPathCache.set(id, path)

      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)
      cameraStreamManager!.subscriberPlaying(id)
      console.log(`[RTMP] postPlay ${path}`, {
        cameraUid,
        id,
        date: Date.now(),
      })
    })

    // donePlay is called when the client is done playing
    nms.on('donePlay', (id, path) => {
      const normalizedPath = normalizePath(path)
      const cameraUid = normalizedPath.split('/').pop() ?? ''

      AppServerError.assert(cameraUid, 'cameraUid required', {
        path,
        id,
        cameraUid,
      })
      // used in doneConnect
      sessionIdToPathCache.set(id, path)

      console.log(`[RTMP] donePlay ${path}`, { cameraUid, id })
      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)
      cameraStreamManager!.subscriberDonePlaying(id)
    })

    nms.on('doneConnect', (id) => {
      const path = sessionIdToPathCache.get(id)

      AppServerError.assert(path, 'path required', {
        path,
        id,
      })

      const normalizedPath = normalizePath(path)
      const cameraUid = normalizedPath.split('/').pop() ?? ''

      AppServerError.assert(cameraUid, 'cameraUid required', {
        path,
        id,
        cameraUid,
      })

      console.log(`[RTMP] doneConnect ${path}`, { cameraUid, id })

      const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)
      cameraStreamManager!.deleteSubscriber(id)
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

      // initialize camera stream manager
      this.cameraStreamManagers.set(
        cameraUid,
        new CameraStreamManager(this.nanitManager, cameraUid),
      )

      // initialize camera message subscription
      if (this.cameraMessageSubscriptions.has(camera.uid)) {
        console.log('[RTMP] camera message subscription already exists', {
          cameraUid,
        })
        return
      }

      const cameraMessages = nanit.pollCameraMessages(
        babyUid,
        NANIT_EVENTS_POLLING_TYPES,
        NANIT_EVENTS_POLLING_INTERVAL,
      )
      const ee = cameraMessages._ee
      const subscription = cameraMessages
        // log only
        .pipe(
          tap((message) => {
            console.log('[RTMP] camera message: next: tap', {
              date: new Date().toISOString(),
              cameraUid,
              babyUid,
              message,
              type: message.type,
            })
          }),
        )
        // leading edge throttle for interval
        .pipe(
          throttleTime(NANIT_EVENTS_POLLING_INTERVAL, undefined, {
            leading: true,
          }),
        )
        .subscribe({
          next: (message) => {
            console.log('[RTMP] camera message: next: throttled', {
              date: new Date().toISOString(),
              cameraUid,
              babyUid,
              message,
              type: message.type,
            })
            // publish "SOUND" or "MOTION"
            const EVENT_SUB_ID = 'EVENT'
            const cameraStreamManager = this.cameraStreamManagers.get(cameraUid)
            cameraStreamManager!
              .addSubscriber(EVENT_SUB_ID)
              .then(() => {
                console.log(
                  '[RTMP] camera message: next: addSubscriber: success',
                  {
                    cameraUid,
                  },
                )
                // delete event subscriber..
                cameraStreamManager!
                  .deleteSubscriber(EVENT_SUB_ID)
                  .then(() => {
                    console.log(
                      '[RTMP] camera message: next:deleteSubscriber: success',
                      {
                        cameraUid,
                      },
                    )
                  })
                  .catch((err) => {
                    console.log(
                      '[RTMP] camera message: next: deleteSubscriber: error',
                      {
                        cameraUid,
                        err,
                      },
                    )
                  })
              })
              .catch((err) => {
                // delete subscribe already happens on error internal to camera stream manager
                console.log(
                  '[RTMP] camera message: next: addSubscriber: error',
                  {
                    cameraUid,
                    err,
                  },
                )
              })
              .finally(() => {
                console.log('[RTMP] camera message: next: mqtt publish', {
                  cameraUid,
                })
                // hack: allow for post publish....
                setTimeout(() => {
                  this.mqtt?.publish(
                    mqttTopic(cameraUid),
                    message.type.toUpperCase() as CameraMessageType,
                  )
                }, 1000)
              })
          },
          error: (err) => {
            console.log('[RTMP] camera message: error', {
              cameraUid,
              babyUid,
              err,
            })
            this.cameraMessageSubscriptions.delete(cameraUid)
            process.exit(1)
          },
          complete: () => {
            console.log('[RTMP] camera message: complete', {
              cameraUid,
              babyUid,
            })
            this.cameraMessageSubscriptions.delete(cameraUid)
            process.exit(1)
          },
        })

      this.cameraMessageSubscriptions.set(cameraUid, { subscription, ee })
    })
  }

  private stopPollingCameraMessages() {
    this.cameraMessageSubscriptions.forEach(({ subscription }) =>
      subscription.unsubscribe(),
    )
    this.cameraMessageSubscriptions.clear()
  }

  private async stopStreamingAll() {
    this.cameraStreamManagers.forEach((cameraStreamManager) => {
      cameraStreamManager.stopStream({ force: true })
    })
    this.cameraStreamManagers.clear()
  }
}

export default AppServer

function wrapInQuotes(str: string): string {
  return `"${str}"`
}
