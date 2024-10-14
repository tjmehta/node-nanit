import ApiClient, {
  ExtendedRequestInit,
  QueryParamsType,
  StatusCodeError,
} from 'simple-api-client'
import validateBabyCameras, { CameraType } from './validateBabyCameras'
import validateSession, { SessionType } from './validateSession'
import { client as proto } from './proto/nanit'

import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'
import validateMfaSession, { MfaSessionType } from './validateMfaSession'
import validateBabyMessages, {
  CameraMessage,
  CameraMessageType,
} from './validateBabyMessage'
import { Observable } from 'rxjs'
import timeout from 'abortable-timeout'
import envVar from 'env-var'
import EventEmitter from 'events'
import { WebSocket } from 'ws'
import {
  CameraSocketsManager,
  StatusCodeError as WebSockerStatusCodeError,
} from './CameraSocketsManager'
import onceFirstEvent from './utils/onFirstEvent'
const { get } = envVar

export const NANIT_REQUEST_TIMEOUT = get('NANIT_REQUEST_TIMEOUT')
  .default(1000 * 20)
  .asIntPositive()
const NANIT_EVENTS_MESSAGE_MAX_AGE = get('NANIT_EVENTS_MESSAGE_MAX_AGE')
  .default(1000 * 60)
  .asIntPositive()
const DEFAULT_HANDSHAKE_TIMEOUT = 1000 * 15

export type CredentialsType = {
  email: string
  password: string
}

export type OptsType = {
  credentials?: CredentialsType | null | undefined
  session?: SessionType | null | undefined
}

export enum NanitAuthStatus {
  NO_CREDENTIALS = 'NO_CREDENTIALS',
  HAS_CREDENTIALS = 'HAS_CREDENTIALS',
  MFA_REQUIRED = 'MFA_REQUIRED',
  AUTHED = 'AUTHED',
}

class NanitError extends BaseError<{}> {}

export default class Nanit extends ApiClient {
  protected lastSocketRequestId = 0
  credentials: CredentialsType | null | undefined
  sessionCache: { value: SessionType; date: Date } | null | undefined
  mfaSessionCache: { value: MfaSessionType; date: Date } | null | undefined
  camerasCache: { value: Array<CameraType>; date: Date } | null | undefined
  cameraSocketsManager = new CameraSocketsManager({
    handshakeTimeout: DEFAULT_HANDSHAKE_TIMEOUT,
  })

  get authStatus() {
    const auth = this.auth

    return auth.status
  }

  get auth() {
    const credentials = this.credentials
    const mfaSession = this.mfaSessionCache?.value
    const session = this.sessionCache?.value

    if (session != null) {
      return {
        status: NanitAuthStatus.AUTHED,
        credentials,
        mfaSession,
        session,
      }
    }

    if (mfaSession != null) {
      return {
        status: NanitAuthStatus.MFA_REQUIRED,
        credentials,
        mfaSession,
        session: null,
      }
    }

    if (credentials != null) {
      return {
        status: NanitAuthStatus.HAS_CREDENTIALS,
        credentials,
        mfaSession: null,
        session: null,
      }
    }

    return {
      status: NanitAuthStatus.NO_CREDENTIALS,
      credentials: null,
      mfaSession: null,
      session: null,
    }
  }

  get email() {
    return this.credentials?.email ?? 'Unknown'
  }

  get password() {
    return this.credentials?.password ?? 'Unknown'
  }

  constructor(opts?: OptsType) {
    super('https://api.nanit.com', async (path, init) => {
      const headers: HeadersInit = {
        ...init?.headers,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'nanit-api-version': '5',
        'User-Agent': 'Nanit/767 CFNetwork/1498.700.2 Darwin/23.6.0',
        'X-Nanit-Service': '3.18.1 (767)',
        'X-Nanit-Platform': 'iPad Pro (12.9-inch) (3rd generation)',
      }

      if (
        path !== 'login' &&
        path !== 'tokens/refresh' &&
        this.sessionCache != null
      ) {
        const session = this.sessionCache.value
        // spammy logging
        // console.log('request: use session', {
        //   refreshToken: session.refreshToken,
        // })
        Object.assign(headers, {
          Authorization: `token ${session.token ?? session.accessToken}`,
        })
      }

      // spammy logging
      // console.log('request: init', path, {
      //   query: init?.query,
      //   json: init?.json,
      //   // @ts-ignore
      //   auth: headers.Authorization ?? headers.authorization ?? null,
      // })

      return {
        ...init,
        headers,
        backoff: {
          statusCodes: /^5..$/,
          timeouts: [100, 200],
        },
      }
    })

    // constructor
    if (opts?.credentials != null) {
      this.credentials = opts.credentials
    }
    if (opts?.session != null) {
      this.sessionCache = {
        value: opts.session,
        date: new Date(),
      }
    }
  }

  async json<
    JsonType extends {} | undefined = {},
    QueryType extends QueryParamsType = {},
  >(
    path: string,
    expectedStatus?:
      | number
      | RegExp
      | ExtendedRequestInit<QueryType, JsonType>
      | null,
    init?: ExtendedRequestInit<QueryType, JsonType> | null,
  ) {
    try {
      return await super.json<JsonType, QueryType>(path, expectedStatus, init)
    } catch (err) {
      if (
        err instanceof StatusCodeError &&
        err.status === 401 &&
        path !== 'login'
      ) {
        // unauthorized error on a non-login request, refresh token and retry
        const { refreshSession } = await import('./server/nanitManager')
        await refreshSession()

        return await super.json<JsonType, QueryType>(path, expectedStatus, init)
      }

      throw err
    }
  }

  logout = () => {
    this.sessionCache = null
    this.mfaSessionCache = null
  }

  login = memoizeConcurrent(
    async (credentials?: CredentialsType | null | undefined) => {
      if (this.sessionCache != null) return this.sessionCache.value
      if (credentials != null) {
        this.credentials = credentials
      }

      const json = await this.post<{ email: string; password: string }>(
        'login',
        /^(201|482)$/,
        {
          json: this.credentials,
        },
      )

      if (json?.mfa_token) {
        this.mfaSessionCache = {
          value: validateMfaSession(json),
          date: new Date(),
        }

        return this.mfaSessionCache.value
      } else {
        this.sessionCache = {
          value: validateSession(json),
          date: new Date(),
        }

        return this.sessionCache.value
      }
    },
    {
      cacheKey: () => 'all',
    },
  )

  loginMfa = memoizeConcurrent(
    async (code: string) => {
      if (this.sessionCache != null) return this.sessionCache.value

      NanitError.assert(
        this.mfaSessionCache != null,
        'mfa session required (login first)',
      )

      const email = this.credentials?.email
      NanitError.assert(email != null, 'auth email required (login first)')

      const password = this.credentials?.password
      NanitError.assert(
        password != null,
        'auth password required (login first)',
      )

      const json = await this.post<{
        email: string
        password: string
        mfa_code: string
        mfa_token: string
      }>('login', /^201$/, {
        json: {
          email,
          password,
          mfa_code: code,
          mfa_token: this.mfaSessionCache.value.mfaToken,
        },
      })

      this.sessionCache = {
        value: validateSession(json),
        date: new Date(),
      }

      return this.sessionCache.value
    },
    {
      cacheKey: () => 'all',
    },
  )

  refreshSession = memoizeConcurrent(
    async (): Promise<SessionType> => {
      NanitError.assert(
        this.sessionCache != null,
        'session required (login first)',
      )

      const json = await this.post<{ refresh_token: string }>(
        'tokens/refresh',
        /^20[0-9]$/,
        {
          json: {
            refresh_token: this.sessionCache.value.refreshToken,
          },
        },
      )

      this.sessionCache = {
        value: validateSession(json),
        date: new Date(),
      }

      return this.sessionCache.value
    },
    {
      cacheKey: () => 'all',
    },
  )

  async getCameras(force?: boolean): Promise<Array<CameraType>> {
    if (
      this.camerasCache != null &&
      this.camerasCache.date.getTime() > Date.now() - 1000 * 60 * 5 &&
      !force
    ) {
      return this.camerasCache.value
    }

    const json = await this.get('babies', 200)

    const cameras = validateBabyCameras(json)
    this.camerasCache = {
      value: cameras,
      date: new Date(),
    }

    return cameras
  }

  async cameraMessages(
    babyUID: string,
    { limit, signal }: { limit: number; signal?: AbortSignal },
  ): Promise<Array<CameraMessage>> {
    const json = await this.json<{}, { limit: string }>(
      `babies/${babyUID}/messages`,
      200,
      {
        query: {
          limit: limit.toString(),
        },
        signal,
      },
    )

    return validateBabyMessages(json)
  }

  pollCameraMessages(
    babyUID: string,
    messageTypes: CameraMessageType[],
    intervalMs: number,
  ): Observable<CameraMessage> & { _ee: EventEmitter } {
    const ee = new EventEmitter()
    const observable = new Observable<CameraMessage>((subscriber) => {
      console.log('[Nanit] pollCameraMessages: subscribe')
      let lastMessage: CameraMessage | null = null
      let requestState: {
        promise: Promise<Array<CameraMessage>> | null
        controller: AbortController | null
      } = {
        promise: null,
        controller: null,
      }

      const makeRequest = () => {
        const controller = new AbortController()
        const promise = Promise.race([
          this.cameraMessages(babyUID, {
            limit: 100,
            signal: controller.signal,
          }),
          timeout(NANIT_REQUEST_TIMEOUT, controller.signal).then(() =>
            Promise.reject(new NanitError('timeout')),
          ),
        ])
        requestState = {
          promise,
          controller,
        }

        promise
          .then((messages) => {
            messages.forEach((message) => {
              const messageAge = Date.now() - message.time * 1000
              if (
                messageTypes.indexOf(message.type) > -1 &&
                messageAge < NANIT_EVENTS_MESSAGE_MAX_AGE &&
                (lastMessage == null || message.time > lastMessage.time)
              ) {
                console.log('[Nanit] pollCameraMessages: message', message)
                lastMessage = message
                subscriber.next(message)
              }
            })
          })
          .catch((err) => {
            subscriber.error(err)
          })
          .finally(() => {
            requestState = {
              promise: null,
              controller: null,
            }
          })
      }

      const interval = setInterval(() => {
        if (requestState.promise != null) {
          console.log('[Nanit] pollCameraMessages: skip makeRequest')
          return
        }
        // spammy logging
        // console.log('[Nanit] pollCameraMessages: makeRequest')
        makeRequest()
      }, intervalMs)

      ee.on('testMessage', (message) => {
        console.log('[Nanit] pollCameraMessages: testMessage', message)
        subscriber.next(message)
      })

      return () => {
        console.log('[Nanit] pollCameraMessages: unsubscribe')
        clearInterval(interval)
        ee.removeAllListeners()
        requestState.controller?.abort()
      }
    })
    //@ts-ignore
    observable._ee = ee
    return observable as Observable<CameraMessage> & { _ee: EventEmitter }
  }

  private async getCameraSocket(
    cameraUID: string,
    attempt: number = 1,
  ): Promise<WebSocket> {
    NanitError.assert(
      this.sessionCache != null,
      'session required (login first)',
    )
    const debug = {
      cameraUID,
      attempt,
    }
    console.log('[Nanit] getCameraSocket', debug)

    try {
      const ws = await this.cameraSocketsManager.getCameraSocket(cameraUID, {
        headers: {
          Authorization: `token ${this.sessionCache.value.token}`,
        },
      })
      console.log('[Nanit] getCameraSocket: success', debug)
      return ws
    } catch (err) {
      if (err instanceof WebSockerStatusCodeError && err.status === 401) {
        // unauthorized error on a non-login request, refresh token and retry
        const { refreshSession } = await import('./server/nanitManager')
        await refreshSession()

        if (attempt < 2) {
          console.warn('[Nanit] getCameraSocket: retry', {
            ...debug,
            attempt,
            err,
          })
          return this.getCameraSocket(cameraUID, attempt + 1)
        }
      }

      console.error('[Nanit] getCameraSocket: error', {
        ...debug,
        err,
      })
      throw err
    }
  }

  protected generateSocketRequestId(): number {
    return ++this.lastSocketRequestId
  }

  async socketRequest<Response extends proto.Response>(
    cameraUID: string,
    request: proto.Request,
  ): Promise<Response> {
    const ws = await this.getCameraSocket(cameraUID)

    return new Promise((resolve, reject) => {
      const debug = {
        cameraUID,
        requestId: request.id,
      }

      /*
       * setup event handlers
       */
      // listen for response
      ws.on('message', handleMessage)
      // listen for socket close
      const removeListeners = onceFirstEvent(ws, {
        close: handleUnexpectedCloseBeforeResponse,
      })
      // race request timeout
      const timeoutId = setTimeout(handleRequestTimeout, NANIT_REQUEST_TIMEOUT)

      /*
       * send message
       */
      const message = proto.Message.create({
        type: proto.Message.Type.REQUEST,
        request,
      })
      ws.send(proto.Message.encode(message).finish(), (err) => {
        if (err != null) {
          console.warn('[Nanit] request: send error', {
            ...debug,
            err,
          })
          reject(err)
        }
      })

      /*
       * handlers
       */
      function handleUnexpectedCloseBeforeResponse() {
        console.warn('[Nanit] request: socket closed', debug)
        cleanup()
        reject(new NanitError('request: socket closed', debug))
      }
      function handleRequestTimeout() {
        console.warn('[Nanit] request: timeout', debug)
        cleanup()
        reject(new NanitError('request: timeout', debug))
      }
      function handleMessage(data: Buffer) {
        const response = proto.Response.decode(new Uint8Array(data))

        // could be spammy..
        // if (response.requestId == null) {
        //   console.log('[Nanit] unexpected response', {})
        //   return
        // }
        if (response.requestId != request.id) {
          // another request's response
          return
        }

        handleResponse(response)
      }
      function handleResponse(response: proto.Response) {
        console.log('[Nanit] response', debug)
        cleanup()
        resolve(response as Response)
      }

      /*
       * cleanup
       */
      function cleanup() {
        removeListeners()
        ws.removeListener('message', handleMessage)
        clearTimeout(timeoutId)
      }
    })
  }

  async startStreaming(cameraUID: string, rtmpUrl: string): Promise<{}> {
    const debug = {
      cameraUID,
      rtmpUrl,
    }
    console.log('[Nanit] startStreaming', debug)

    const request = proto.Request.create({
      id: this.generateSocketRequestId(),
      type: proto.RequestType.PUT_STREAMING,
      streaming: proto.Streaming.create({
        id: proto.StreamIdentifier.MOBILE,
        status: proto.Streaming.Status.STARTED,
        rtmpUrl,
        attempts: 1,
      }),
    })
    try {
      const res = await this.socketRequest(cameraUID, request)
      const json = res.toJSON()

      console.log('[Nanit] startStreaming: success', {
        ...debug,
        res: json,
      })

      return json
    } catch (err) {
      console.warn('[Nanit] startStreaming: error', {
        ...debug,
        err,
      })
      throw err
    }
  }

  async stopStreaming(cameraUID: string, rtmpUrl: string): Promise<{}> {
    const debug = {
      cameraUID,
      rtmpUrl,
    }
    console.log('[Nanit] stopStreaming', debug)

    const request = proto.Request.create({
      id: this.generateSocketRequestId(),
      type: proto.RequestType.PUT_STREAMING,
      streaming: proto.Streaming.create({
        id: proto.StreamIdentifier.MOBILE,
        status: proto.Streaming.Status.STOPPED,
        rtmpUrl,
        attempts: 1,
      }),
    })

    try {
      const res = await this.socketRequest(cameraUID, request)
      const json = res.toJSON()

      console.log('[Nanit] stopStreaming: success', {
        ...debug,
        res: json,
      })

      return json
    } catch (err) {
      console.warn('[Nanit] stopStreaming: error', {
        ...debug,
        err,
      })
      return {}
    }
  }
}
