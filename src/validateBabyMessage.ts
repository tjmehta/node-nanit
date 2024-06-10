import BaseError from 'baseerr'

export enum CameraModeType {
  TRAVEL = 'TRAVEL',
}
export enum CameraHardwareType {
  GEN2 = 'gen_2',
}

export type MessageType = {
  id: number // int
  babyUID: string
  userId: number // int
  type: string
  time: Date
  readAt: string
  seenAt: string
  dismissedAt: string
  updatedAt: string
  createdAt: string
}

class InvalidMessagesError extends BaseError<{ json: {} }> {}
class InvalidMessageError extends BaseError<{ message: {} }> {}

export default function validateBabyMessages(json: any): Array<MessageType> {
  if (typeof json != 'object') {
    throw new InvalidMessagesError('invalid messages response', { json })
  }
  if (Array.isArray(json)) {
    throw new InvalidMessagesError('invalid messages: not array', { json })
  }
  return json
    .map((message: any) => {
      return validateMessage(message)
    })
    .filter((message: MessageType | null) => message != null)
}

function validateMessage(message: any): MessageType | null {
  if (typeof message != 'object') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.id != 'number') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.baby_uid != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.user_id != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  // TODO: validate enum
  if (typeof message.type != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.time != 'number') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.read_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.seen_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.dismissed_at != 'string') {
    throw new InvalidMessageError('invalid message', { message })
  }
  if (typeof message.updated_at != 'string') {
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
    readAt: read_at,
    seenAt: seen_at,
    dismissedAt: dismissed_at,
    updatedAt: updated_at,
    createdAt: created_at,
  }
}
