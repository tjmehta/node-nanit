// jest.setup.js
import fetch from 'node:fetch'

globalThis.fetch = fetch
globalThis.Request = fetch.Request
globalThis.Response = fetch.Response
globalThis.Headers = fetch.Headers
