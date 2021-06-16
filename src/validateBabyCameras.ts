import BaseError from 'baseerr'

export enum CameraModeType {
  TRAVEL = 'TRAVEL',
}
export enum CameraHardwareType {
  GEN2 = 'gen_2',
}

export type CameraType = {
  uid: string
  mode: CameraModeType
  connected: boolean
  hardware: CameraHardwareType
  active: boolean
  publicAddress: string // `${ip}:${port}`
  privateAddress: string // // `${ip}:${port}`
  speaker: boolean
}

class InvalidBabiesError extends BaseError<{ json: {} }> {}
class InvalidCameraError extends BaseError<{ camera: {} }> {}

export default function validateBabyCameras(json: any): Array<CameraType> {
  if (typeof json != 'object') {
    throw new InvalidBabiesError('invalid babies response', { json })
  }
  if (Array.isArray(json.babies)) {
    throw new InvalidBabiesError('invalid babies property', { json })
  }
  return json.babies
    .map((baby: any) => {
      return validateCamera(baby.camera)
    })
    .filter((camera: CameraType | null) => camera != null)
}

function validateCamera(camera: any): CameraType | null {
  if (typeof camera != 'object') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  if (typeof camera.uid != 'string') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  // TODO: validate enum
  if (typeof camera.mode != 'string') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  if (typeof camera.connected != 'boolean') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  // TODO: validate enum
  if (typeof camera.hardware != 'string') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  if (typeof camera.active != 'boolean') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  if (typeof camera.public_address != 'string') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  if (typeof camera.private_address != 'string') {
    throw new InvalidCameraError('invalid camera', { camera })
  }
  if (typeof camera.speaker != 'boolean') {
    throw new InvalidCameraError('invalid camera', { camera })
  }

  const {
    uid,
    mode,
    connected,
    hardware,
    active,
    public_address,
    private_address,
    speaker,
  } = camera

  return {
    uid,
    mode,
    connected,
    hardware,
    active,
    publicAddress: public_address,
    privateAddress: private_address,
    speaker,
  }
}
