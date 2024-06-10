import ApiClient, {
  ExtendedRequestInit,
  QueryParamsType,
  StatusCodeError,
  setFetch,
} from 'simple-api-client'
import validateBabyCameras, { CameraType } from './validateBabyCameras'
import validateSession, { SessionType } from './validateSession'

import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'
import validateMfaSession, { MfaSessionType } from './validateMfaSession'
import validateBabyMessages, { MessageType } from './validateBabyMessage'
import { WebSocket } from './WebSocketManager'
import CameraSocketManager from './CameraSocketManager'

type OptsType = {
  email: string
  password: string
}

export default class Nanit extends ApiClient {
  auth: {
    email: string
    password: string
  }
  sessionCache: { value: SessionType; date: Date } | null | undefined
  mfaSessionCache: { value: MfaSessionType; date: Date } | null | undefined
  cameraSocketManager: CameraSocketManager | null | undefined

  constructor(opts: OptsType) {
    super('https://api.nanit.com', async (path, init) => {
      const headers: HeadersInit = {
        ...init?.headers,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'nanit-api-version': '2',
        'User-Agent': 'Nanit/699 CFNetwork/1474 Darwin/23.0.0',
        'X-Nanit-Service': '3.11.27 (699)',
        'X-Nanit-Platform': 'iPhone 14 Pro Max',
      }
      if (
        path !== 'login' &&
        path !== 'tokens/refresh' &&
        this.sessionCache != null
      ) {
        const session = this.sessionCache.value
        console.log('use session', { path, session })
        Object.assign(headers, {
          Authorization: `token ${session.token ?? session.accessToken}`,
        })
      }

      console.log('init', path, {
        ...init,
        headers,
        backoff: {
          statusCodes: /^5..$/,
          timeouts: [100, 200],
        },
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

    this.auth = {
      email: opts.email,
      password: opts.password,
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
    let json: JsonType
    try {
      return await super.json<JsonType, QueryType>(path, expectedStatus, init)
    } catch (err) {
      // if (
      //   err instanceof StatusCodeError &&
      //   err.status === 401 &&
      //   path !== 'login'
      // ) {
      //   // unauthorized error on a non-login request, refresh token and retry
      //   await this.refreshSession()
      //   return await super.json<JsonType, QueryType>(path, expectedStatus, init)
      // }

      throw err
    }
  }

  login = memoizeConcurrent(
    async () => {
      if (this.sessionCache != null) return this.sessionCache.value

      const json = await this.post<{ email: string; password: string }>(
        'login',
        /^(201|482)$/,
        {
          json: this.auth,
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

      const json = await this.post<{
        email: string
        password: string
        mfa_code: string
        mfa_token: string
      }>('login', /^201$/, {
        json: {
          ...this.auth,
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

      return this.sessionCache.value
    },
    {
      cacheKey: () => 'all',
    },
  )

  async getCameras(): Promise<Array<CameraType>> {
    const json = await this.get('babies', 200)

    return validateBabyCameras(json)
  }

  async cameraMessages(
    babyUID: string,
    { limit }: { limit: number },
  ): Promise<Array<MessageType>> {
    const json = await this.json<{}, { limit: string }>(
      `babies/${babyUID}/messages`,
      200,
      {
        query: {
          limit: limit.toString(),
        },
      },
    )

    return validateBabyMessages(json)
  }

  private getConnectedWebSocket = memoizeConcurrent(
    async (cameraUID: string): Promise<WebSocket> => {
      BaseError.assert(
        this.sessionCache != null,
        'session required (login first)',
      )

      if (this.cameraSocketManager == null) {
        this.cameraSocketManager = new CameraSocketManager(cameraUID, {
          headers: {
            Authorization: `token ${
              this.sessionCache.value.token ??
              this.sessionCache.value.accessToken
            }`,
          },
        })
      }

      return this.cameraSocketManager.getConnectedWebSocket()
    },
  )
}
