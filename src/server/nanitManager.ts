import { writeFile, readFile, unlink } from 'fs/promises'
import { mkdirSync, readFileSync } from 'fs'
import path from 'path'
import Nanit, { CredentialsType, NanitAuthStatus } from '../index'
import assert from 'assert'
import { StatusCodeError } from 'simple-api-client'

enum NanitAuthCacheKeys {
  SESSION = 'session',
  CREDENTIALS = 'credentials',
}
class NanitAuthCache {
  private cacheDir: string = path.resolve('./', '.cache')

  constructor() {
    mkdirSync(this.cacheDir, { recursive: true })
  }

  getPath(key: string) {
    console.log('[NanitAuthCache getPath]', key, path.join(this.cacheDir, key))
    return path.join(this.cacheDir, key)
  }

  async set(key: NanitAuthCacheKeys, value: any) {
    console.log('[NanitAuthCache set]', key, value)
    return writeFile(this.getPath(key), JSON.stringify(value))
  }

  async get(key: NanitAuthCacheKeys) {
    try {
      const data = await readFile(this.getPath(key), 'utf8')
      console.log('[NanitAuthCache get]', key, data)
      return JSON.parse(data)
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async delete(key: NanitAuthCacheKeys) {
    try {
      return await unlink(this.getPath(key))
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async clear() {
    await Promise.all(
      Object.values(NanitAuthCacheKeys).map((key) => this.delete(key)),
    )
  }

  getSync(key: NanitAuthCacheKeys) {
    try {
      const data = readFileSync(this.getPath(key), 'utf8')
      console.log('[NanitAuthCache getSync]', key, data)
      return JSON.parse(data)
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
}

export class NanitManager {
  private nanit: Nanit = new Nanit()
  private nanitCache: NanitAuthCache = new NanitAuthCache()

  constructor() {
    // initialize nanit from cache if it exists
    const credentials = this.nanitCache.getSync(NanitAuthCacheKeys.CREDENTIALS)

    if (credentials != null) {
      this.nanit = new Nanit({
        credentials,
        session: this.nanitCache.getSync(NanitAuthCacheKeys.SESSION),
      })
    }
  }

  async login(credentials: CredentialsType) {
    await this.nanitCache.clear()
    await this.nanitCache.set(NanitAuthCacheKeys.CREDENTIALS, credentials)

    const nanit = (this.nanit = new Nanit({
      credentials,
    }))
    await nanit.login()

    if (nanit.auth.status === NanitAuthStatus.AUTHED) {
      await this.nanitCache.set(NanitAuthCacheKeys.SESSION, nanit.auth.session)
    }

    return this.nanit
  }

  async loginMfa(code: string) {
    const nanit = this.nanit
    let auth = nanit.auth

    assert(
      auth.status === NanitAuthStatus.MFA_REQUIRED,
      'invalid auth status, no mfa required',
    )

    await nanit.loginMfa(code)
    auth = nanit.auth

    if (auth.status === NanitAuthStatus.AUTHED) {
      await this.nanitCache.set(NanitAuthCacheKeys.SESSION, auth.session)
    }

    return auth
  }

  async refreshSession() {
    const nanit = this.nanit

    if (nanit.auth.status === NanitAuthStatus.AUTHED) {
      try {
        await nanit.refreshSession()
      } catch (err: any) {
        if (err instanceof StatusCodeError && err.status === 401) {
          this.clearSession()
        }
        throw err
      }
    }

    if (nanit.auth.status === NanitAuthStatus.AUTHED) {
      await this.nanitCache.set(NanitAuthCacheKeys.SESSION, nanit.auth.session)
    }

    return this.nanit
  }

  async logout() {
    await this.nanitCache.clear()
    this.nanit = new Nanit()
  }

  async clearSession() {
    await this.nanitCache.delete(NanitAuthCacheKeys.SESSION)
  }

  get() {
    return this.nanit
  }
}
const nanitManager = new NanitManager()

export default nanitManager

export async function refreshSession() {
  return nanitManager.refreshSession()
}
