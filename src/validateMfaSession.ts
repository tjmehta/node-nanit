import BaseError from 'baseerr'

export type MfaSessionType = {
  mfaToken: string
  phoneSuffix?: string
  channel?: string
}

class InvalidMfaSessionError extends BaseError<{}> {}

export default function validateMfaSession(session: any): MfaSessionType {
  if (typeof session != 'object') {
    throw new InvalidMfaSessionError('invalid mfa session', { session })
  }
  let { mfa_token, phone_suffix, channel } = session
  if (typeof mfa_token != 'string') {
    throw new InvalidMfaSessionError('invalid mfa_token', { session })
  }
  return {
    mfaToken: mfa_token,
    phoneSuffix: phone_suffix,
    channel: channel,
  }
}
