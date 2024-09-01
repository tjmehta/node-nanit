import BaseError from 'baseerr'

export enum CameraModeType {
  TRAVEL = 'TRAVEL',
}
export enum CameraHardwareType {
  GEN2 = 'gen_2',
}

export enum CameraMessageType {
  SOUND = 'SOUND',
  MOTION = 'MOTION',
  TEMPERATURE = 'TEMPERATURE',
}

export type CameraMessage = {
  id: number // int
  babyUID: string
  userId: number // int
  type: CameraMessageType
  time: number // int in seconds
  readAt: Date | null
  seenAt: Date | null
  dismissedAt: Date | null
  updatedAt: Date | null
  createdAt: string
}

class InvalidMessagesError extends BaseError<{ json: {} }> {}
class InvalidMessageError extends BaseError<{ message: {} }> {}

export default function validateBabyMessages(json: any): Array<CameraMessage> {
  if (typeof json != 'object' || json == null) {
    throw new InvalidMessagesError('invalid messages response', { json })
  }
  if (!Array.isArray(json.messages)) {
    throw new InvalidMessagesError('invalid messages: not array', { json })
  }
  return json.messages
    .map((message: any) => {
      return validateMessage(message)
    })
    .filter(
      (message: CameraMessage | null) => message != null,
    ) as Array<CameraMessage>
}

function validateMessage(message: any): CameraMessage | null {
  if (typeof message != 'object') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.id != 'number') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.baby_uid != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.user_id != 'number') {
    throw new InvalidMessageError('invalid message', { message })
  }
  // TODO: validate enum
  if (typeof message.type != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.time != 'number') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (message.read_at != null && typeof message.read_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (message.seen_at != null && typeof message.seen_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (message.dismissed_at != null && typeof message.dismissed_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (message.updated_at != null && typeof message.updated_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.created_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }

  const {
    id,
    baby_uid,
    user_id,
    type,
    time,
    read_at,
    seen_at,
    dismissed_at,
    updated_at,
    created_at,
  } = message

  return {
    id,
    babyUID: baby_uid,
    userId: user_id,
    type,
    time,
    readAt: read_at ? new Date(read_at) : null,
    seenAt: seen_at ? new Date(seen_at) : null,
    dismissedAt: dismissed_at ? new Date(dismissed_at) : null,
    updatedAt: updated_at ? new Date(updated_at) : null,
    createdAt: created_at,
  }
}
