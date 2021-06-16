import ApiClient, {
  ExtendedRequestInit,
  QueryParamsType,
  StatusCodeError,
} from 'simple-api-client'
import validateBabyCameras, { CameraType } from './validateBabyCameras'
import validateSession, { SessionType } from './validateSession'

import BaseError from 'baseerr'
import memoizeConcurrent from 'memoize-concurrent'

export { setFetch } from 'simple-api-client'

type OptsType = {
  email: string
  password: string
}

export default class Nanit extends ApiClient {
  auth: {
    email: string
    password: string
  }
  session: SessionType | null | undefined

  constructor(opts: OptsType) {
    super('https://api.nanit.com', async (path, init) => {
      const headers: HeadersInit = {
        ...init?.headers,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-us',
        'Content-Type': 'application/json',
        'nanit-api-version': '1',
        'User-Agent': 'Nanit/386 CFNetwork/1240.0.4 Darwin/20.5.0',
        'X-Nanit-Service': '3.1.4 (386)',
        'X-Nanit-Platform': 'unknown',
      }

      if (path !== 'login') {
        const session = await this.login()
        Object.assign(headers, {
          Authorization: `token ${session.token ?? session.accessToken}`,
        })
      }

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

  async json<JsonType = {}, QueryType extends QueryParamsType = {}>(
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
      if (
        err instanceof StatusCodeError &&
        err.status === 401 &&
        path !== 'login'
      ) {
        // unauthorized error on a non-login request, refresh token and retry
        await this.refreshSession()
        return await super.json<JsonType, QueryType>(path, expectedStatus, init)
      }

      throw err
    }
  }

  login = memoizeConcurrent(
    async () => {
      if (this.session != null) return this.session

      const json = await this.post<{ email: string; password: string }>(
        'login',
        201,
        {
          json: this.auth,
        },
      )
      this.session = validateSession(json)

      return this.session
    },
    {
      cacheKey: () => 'all',
    },
  )

  refreshSession = memoizeConcurrent(
    async (): Promise<SessionType> => {
      if (this.auth == null || this.session == null) {
        // no auth or session
        throw new BaseError('unauthorized', {
          login: this.auth,
          session: this.session,
        })
      }

      this.session = null
      this.session = await this.login()

      return this.session
    },
    {
      cacheKey: () => 'all',
    },
  )

  async cameras(): Promise<Array<CameraType>> {
    const json = await this.get('babies', 200)
    return validateBabyCameras(json)
  }
}
