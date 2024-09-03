import ApiClient, {
  ExtendedRequestInit,
  QueryParamsType,
  StatusCodeError,
} from 'simple-api-client'
import validateBabyCameras, { CameraType } from './validateBabyCameras'
import validateSession, { SessionType } from './validateSession'

import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'
import validateMfaSession, { MfaSessionType } from './validateMfaSession'
import validateBabyMessages, {
  CameraMessage,
  CameraMessageType,
} from './validateBabyMessage'
import CameraSocketManager from './CameraSocketManager'
import { Observable } from 'rxjs'
import timeout from 'abortable-timeout'
import envVar from 'env-var'
import { StatusCodeError as WebSockerStatusCodeError } from './WebSocketManager'
const { get } = envVar

const NANIT_REQUEST_TIMEOUT = get('NANIT_REQUEST_TIMEOUT')
  .default(1000 * 20)
  .asIntPositive()
const NANIT_EVENTS_MESSAGE_MAX_AGE = get('NANIT_EVENTS_MESSAGE_MAX_AGE')
  .default(1000 * 60)
  .asIntPositive()

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

export default class Nanit extends ApiClient {
  credentials: CredentialsType | null | undefined
  sessionCache: { value: SessionType; date: Date } | null | undefined
  mfaSessionCache: { value: MfaSessionType; date: Date } | null | undefined
  cameraSocketManagers = new Map<string, CameraSocketManager>()
  camerasCache: { value: Array<CameraType>; date: Date } | null | undefined

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
        console.log('request: use session', {
          refreshToken: session.refreshToken,
        })
        Object.assign(headers, {
          Authorization: `token ${session.token ?? session.accessToken}`,
        })
      }

      console.log('request: init', path, {
        query: init?.query,
        json: init?.json,
        // @ts-ignore
        auth: headers.Authorization ?? headers.authorization ?? null,
      })

      return {
        ...init,
        headers,
        backoff: {
          statusCodes: /^5..$/,
          timeouts: [100, 200],
        },
      }
    })

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

      BaseError.assert(
        this.mfaSessionCache != null,
        'mfa session required (login first)',
      )

      const email = this.credentials?.email
      BaseError.assert(email != null, 'auth email required (login first)')

      const password = this.credentials?.password
      BaseError.assert(password != null, 'auth password required (login first)')

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
      BaseError.assert(
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

      await this.resetCameraSocketManagers()

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
  ): Observable<CameraMessage> {
    return new Observable((subscriber) => {
      console.log('CameraSocketManager: pollCameraMessages: subscribe')
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
            Promise.reject(new Error('timeout')),
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
                console.log(
                  'CameraSocketManager: pollCameraMessages: message',
                  message,
                )
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
          console.log(
            'CameraSocketManager: pollCameraMessages: skip makeRequest',
          )
          return
        }
        console.log('CameraSocketManager: pollCameraMessages: makeRequest')
        makeRequest()
      }, intervalMs)

      return () => {
        console.log('CameraSocketManager: pollCameraMessages: unsubscribe')
        clearInterval(interval)
        requestState.controller?.abort()
      }
    })
  }

  private resetCameraSocketManagers = async () => {
    await Promise.all(
      [...this.cameraSocketManagers.keys()].map((cameraUID) =>
        this.resetCameraSocketManager(cameraUID),
      ),
    )
  }

  private getCameraSocketManager = memoizeConcurrent(
    async (cameraUID: string): Promise<CameraSocketManager> => {
      BaseError.assert(
        this.sessionCache != null,
        'session required (login first)',
      )
      let cameraSocketManager = this.cameraSocketManagers.get(cameraUID)

      if (cameraSocketManager == null) {
        cameraSocketManager = new CameraSocketManager(cameraUID, {
          ws: {
            headers: {
              Authorization: `Bearer ${
                this.sessionCache.value.token ??
                this.sessionCache.value.accessToken
              }`,
            },
          },
          requestTimeoutMs: NANIT_REQUEST_TIMEOUT,
        })
        this.cameraSocketManagers.set(cameraUID, cameraSocketManager)
      }
      try {
        await cameraSocketManager.start()
      } catch (err) {
        if (err instanceof WebSockerStatusCodeError && err.status === 401) {
          console.warn(
            'CameraSocketManager: getCameraSocketManager: start: error',
            { cameraUID, err },
          )
          await this.refreshSession()
          return this.resetCameraSocketManager(cameraUID)
        }
        throw err
      }

      return cameraSocketManager
    },
  )

  private resetCameraSocketManager = memoizeConcurrent(
    async (cameraUID: string): Promise<CameraSocketManager> => {
      BaseError.assert(
        this.sessionCache != null,
        'session required (login first)',
      )
      let cameraSocketManager = this.cameraSocketManagers.get(cameraUID)

      if (cameraSocketManager != null) {
        await cameraSocketManager.stop().catch((err) => {
          console.warn(
            'CameraSocketManager: resetCameraSocketManager: stop: error',
            { cameraUID, err },
          )
        })
        this.cameraSocketManagers.delete(cameraUID)
      }

      cameraSocketManager = new CameraSocketManager(cameraUID, {
        ws: {
          headers: {
            Authorization: `Bearer ${
              this.sessionCache.value.token ??
              this.sessionCache.value.accessToken
            }`,
          },
        },
        requestTimeoutMs: NANIT_REQUEST_TIMEOUT,
      })
      this.cameraSocketManagers.set(cameraUID, cameraSocketManager)
      await cameraSocketManager.start()

      return cameraSocketManager
    },
  )

  async startStreaming(cameraUID: string, rtmpUrl: string): Promise<{}> {
    const socket = await this.getCameraSocketManager(cameraUID)
    const payload = await socket.startStreaming(rtmpUrl)

    return payload
  }

  async stopStreaming(cameraUID: string, rtmpUrl: string): Promise<{}> {
    const socket = await this.getCameraSocketManager(cameraUID)
    const payload = await socket.stopStreaming(rtmpUrl)

    return payload
  }
}
