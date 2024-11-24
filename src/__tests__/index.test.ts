import { Polly, PollyConfig } from '@pollyjs/core'
import NodeHttpAdapter from '@pollyjs/adapter-node-http'
// import FetchAdapter from '@pollyjs/adapter-fetch'
import FSPersister from '@pollyjs/persister-fs'
import path from 'path'
import readLine from '../utils/readLine'

import Nanit, { OptsType } from '../Nanit'
// import fetch from './fetch.cjs'
import { setFetch } from 'simple-api-client'
import dotenv from 'dotenv'
import fetch from 'node-fetch/src/index.js'
import context from 'node-media-server/src/node_core_ctx.js'
import fs from 'fs/promises'
import { native as rimraf } from 'rimraf'

const rewriteRecordings = process.argv.includes('-u')

if (rewriteRecordings) {
  // source .env.test.local
  dotenv.config({
    path: path.join(process.cwd(), '.env.test.local'),
  })
}

const opts: OptsType = {
  credentials: {
    email: process.env.EMAIL ?? '********email*********',
    password: process.env.PASSWORD ?? '********password********',
  },
}

setFetch(fetch as any)

describe.skip('Nanit', () => {
  const ctx: { polly?: Polly } = {}

  /**
   * Helpers
   */
  async function mockRequests(folderPrefix: string) {
    const recordingsDir = path.join(
      process.cwd(),
      'src',
      '__tests__',
      '__recordings__',
    )
    const pollyOpts: PollyConfig = {
      adapters: ['node-http'],
      persister: 'fs',
      recordIfMissing: rewriteRecordings ? undefined : true,
      recordFailedRequests: rewriteRecordings ? true : true,
      matchRequestsBy: {
        method: true,
        url: true,
        body: (input) => (input.mfa_code ? 'mfa' : 'pwd'),
        headers: false,
      },
    }

    const overwriteMocks = process.argv.indexOf('-u') !== -1

    if (overwriteMocks) {
      const files = await fs.readdir(recordingsDir)
      console.log('warn: attempting to remove request mocks', folderPrefix)
      const mocksDirname = files.find((f) => f.startsWith(`${folderPrefix}_`))

      if (mocksDirname != null) {
        const mocksFilepath = path.join(recordingsDir, mocksDirname)
        console.log(
          `warn: removing request mocks dir for "${folderPrefix}"`,
          mocksFilepath,
        )

        await rimraf(mocksFilepath)
      }
    }

    const polly = (ctx.polly = new Polly(folderPrefix, {
      ...pollyOpts,
      persisterOptions: {
        fs: {
          recordingsDir,
        },
      },
    }))

    return polly
  }

  /**
   * Tests
   */
  beforeEach(async () => {
    // Register the adapters and persisters we want to use
    Polly.register(NodeHttpAdapter)
    Polly.register(FSPersister)
  })
  afterEach(async () => {
    ctx.polly?.stop()
  })

  it('should create instance of api client', () => {
    const nanit = new Nanit(opts)
    expect(nanit).toBeInstanceOf(Nanit)
  })

  it('should login', async () => {
    const polly = (ctx.polly = await mockRequests('login'))
    const nanit = new Nanit(opts)

    const mfa = await nanit.login()
    expect(mfa).toMatchInlineSnapshot(`
      {
        "channel": "sms",
        "mfaToken": "************mfa_token*************",
        "phoneSuffix": "**",
      }
    `)

    await polly.stop()
  })

  it('should mfa', async () => {
    // jest.testTimeout(70000)
    const polly = (ctx.polly = await mockRequests('mfa'))
    const nanit = new Nanit(opts)

    // login w/ pass and get mfa info
    const mfa = await nanit.login()
    expect(mfa).toMatchInlineSnapshot(`
      {
        "channel": "sms",
        "mfaToken": "************mfa_token*************",
        "phoneSuffix": "**",
      }
    `)

    // login w/ mfa code
    const code = process.argv.find((v) => v === '-u')
      ? await readLine()
      : '****'
    const session = await nanit.loginMfa(code)
    expect(session).toMatchInlineSnapshot(`
      {
        "accessToken": "******************access_token******************",
        "refreshToken": "*****************refresh_token******************",
        "token": "*********************token**********************",
      }
    `)

    await polly.stop()
  }, 60000)

  it(
    'should get cameras (babies)',
    async () => {
      const polly = (ctx.polly = await mockRequests('cameras'))
      const nanit = new Nanit(opts)

      // login w/ pass and get mfa info
      const mfa = await nanit.login()
      expect(mfa).toMatchInlineSnapshot(`
        {
          "channel": "sms",
          "mfaToken": "************mfa_token*************",
          "phoneSuffix": "**",
        }
      `)

      // login w/ mfa code
      const code = process.argv.find((v) => v === '-u')
        ? await readLine()
        : '****'
      const session = await nanit.loginMfa(code)
      expect(session).toMatchInlineSnapshot(`
        {
          "accessToken": "******************access_token******************",
          "refreshToken": "*****************refresh_token******************",
          "token": "*********************token**********************",
        }
      `)

      const cameras = await nanit.getCameras()
      expect(cameras).toMatchInlineSnapshot(`
        [
          {
            "active": true,
            "connected": true,
            "hardware": "gen_2",
            "mode": "STAND",
            "privateAddress": "*private_address*",
            "publicAddress": "***************",
            "speaker": true,
            "uid": "*****uid******",
          },
          {
            "active": true,
            "connected": true,
            "hardware": "gen_2",
            "mode": "STAND",
            "privateAddress": "****************",
            "publicAddress": "***************",
            "speaker": true,
            "uid": "*****uid******",
          },
        ]
      `)

      await polly.stop()
    },
    60 * 1000,
  )

  it.only(
    'should start camera streaming',
    async () => {
      const polly = (ctx.polly = await mockRequests('cameras'))
      const nanit = new Nanit({
        ...opts,
        session: {
          accessToken: 'a651c7ca8dae425ab2953e26ad68d7baddfa71c47fb40901',
          refreshToken: 'af9f802775692856258c5b4fd25e45382ec5e391ea7ca17b',
          token: 'a651c7ca8dae425ab2953e26ad68d7baddfa71c47fb40901',
        },
      })
      // // login w/ pass and get mfa info
      // const mfa = await nanit.login()
      // // login w/ mfa code
      // const code = process.argv.find((v) => v === '-u')
      //   ? await readLine()
      //   : '****'
      // const session = await nanit.loginMfa(code)
      // expect(session).toMatchInlineSnapshot(`
      //   {
      //     "accessToken": "de321adbc34606c6e8f1146b4121ebb0a3e0a6aff8c060ec",
      //     "refreshToken": "0c99339916f3a441c44de881ba9d994389fcae9ddcb8bae0",
      //     "token": "de321adbc34606c6e8f1146b4121ebb0a3e0a6aff8c060ec",
      //   }
      // `)
      const cameras = await nanit.getCameras()
      const camera = cameras[0]
      expect(camera).toMatchInlineSnapshot(`
        {
          "active": true,
          "connected": true,
          "hardware": "gen_2",
          "mode": "STAND",
          "privateAddress": "192.168.1.237:442",
          "publicAddress": "24.7.8.87:35664",
          "speaker": true,
          "uid": "N301CMN23332EF",
        }
      `)

      await polly.stop()
      const rtmpUrl = `rtmp://192.168.1.242:1935/live/${camera.uid}`
      // const rtmpUrl = 'rtmp://192.168.1.240:1935/local/N301CMN23332EF'
      const payload = await nanit.startStreaming(camera.uid, rtmpUrl)
      expect(payload).toMatchInlineSnapshot(`
        {
          "requestId": 1,
          "requestType": "PUT_STREAMING",
          "statusCode": 200,
        }
      `)
    },
    600 * 1000,
  )
})
