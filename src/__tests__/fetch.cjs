// mod.cjs
const fetch = async (...args) => {
  const { fetch: _fetch } = await importAndSetFetch()
  return _fetch(...args)
}

let cached = null
async function importAndSetFetch() {
  if (cached) return cached

  const {
    default: fetch,
    Response,
    Request,
    Headers,
  } = await import('node-fetch')

  global.fetch = fetch
  global.Request = Request
  global.Response = Response
  global.Headers = Headers

  cached = { fetch, Response, Request, Headers }

  return cached
}

module.exports = fetch
module.exports.importAndSetFetch = importAndSetFetch
