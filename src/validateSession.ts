import BaseError from 'baseerr'

export type SessionType = {
  accessToken: string
  refreshToken: string
  token: string
}

class InvalidSessionError extends BaseError<{}> {}

export default function validateSession(session: any): SessionType {
  if (typeof session != 'object') {
    throw new InvalidSessionError('invalid session', { session })
  }
  let { access_token, refresh_token, token } = session
  if (typeof access_token != 'string') {
    throw new InvalidSessionError('invalid access_token', { session })
  }
  if (typeof refresh_token != 'string') {
    throw new InvalidSessionError('invalid refresh_token', { session })
  }
  if (typeof token != 'string') {
    throw new InvalidSessionError('invalid token', { session })
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    token: token,
  }
}
