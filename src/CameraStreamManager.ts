import BaseError from 'baseerr'
import { NanitManager } from './server/nanitManager'
import { get } from 'env-var'
import memoizeConcurrent from 'memoize-concurrent'
import timeout from 'abortable-timeout'

const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const NANIT_CAMERA_STOP_DELAY = get('NANIT_CAMERA_STOP_DELAY')
  .default(3 * 60 * 1000)
  .asIntPositive()

class StreamSubscribersError extends BaseError<{
  cameraUid: string
  id: string
}> {}

enum StreamSubscriberStatus {
  CONNECTED = 'connected',
  PLAYING = 'playing',
  DONE_PLAYING = 'done_playing',
  DISCONNECTED = 'disconnected',
}

class StreamSubscribers {
  private cameraUid: string
  private cameraSubscribers: Map<string, StreamSubscriberStatus> = new Map()

  constructor(cameraUid: string) {
    this.cameraUid = cameraUid
  }

  get size() {
    return this.cameraSubscribers.size
  }

  getAllSubscribersStatus() {
    const subscribers = this.cameraSubscribers

    let mostActiveStatus = StreamSubscriberStatus.DISCONNECTED

    for (const status of subscribers.values()) {
      if (
        status === StreamSubscriberStatus.PLAYING
        // && mostActiveStatus !== StreamSubscriberStatus.PLAYING
      ) {
        mostActiveStatus = StreamSubscriberStatus.PLAYING
        break
      }

      if (status === StreamSubscriberStatus.CONNECTED) {
        mostActiveStatus = StreamSubscriberStatus.CONNECTED
      } else if (
        status === StreamSubscriberStatus.DONE_PLAYING &&
        mostActiveStatus !== StreamSubscriberStatus.CONNECTED
      ) {
        mostActiveStatus = StreamSubscriberStatus.DONE_PLAYING
      } else if (
        status === StreamSubscriberStatus.DISCONNECTED &&
        mostActiveStatus !== StreamSubscriberStatus.CONNECTED &&
        mostActiveStatus !== StreamSubscriberStatus.DONE_PLAYING
      ) {
        mostActiveStatus = StreamSubscriberStatus.DISCONNECTED
      }
    }

    return mostActiveStatus
  }

  addSubscriber(id: string) {
    const prevSize = this.size
    this.cameraSubscribers.set(id, StreamSubscriberStatus.CONNECTED)
    const currSize = this.size

    return currSize > prevSize
  }

  subscriberPlaying(id: string) {
    const status = this.cameraSubscribers.get(id)

    // error if not connected
    if (status !== StreamSubscriberStatus.CONNECTED) {
      console.warn('unexpected playing', {
        cameraUid: this.cameraUid,
        id,
      })
    }

    this.cameraSubscribers.set(id, StreamSubscriberStatus.PLAYING)
  }

  subscriberDonePlaying(id: string) {
    this.cameraSubscribers.set(id, StreamSubscriberStatus.DONE_PLAYING)
  }

  deleteSubscriber(id: string) {
    const prevSize = this.size
    this.cameraSubscribers.delete(id)
    const currSize = this.size

    return currSize < prevSize
  }
}

enum CameraStreamStatus {
  START_REQUESTED = 'start_requested',
  START_RESPONDED = 'start_responded',
  PUBLISHING = 'publishing',
  STOP_REQUESTED = 'stop_requested',
  STOP_RESPONDED = 'stop_responded',
  DONE_PUBLISHING = 'done_publishing',
}

class CameraStreamManagerError extends BaseError<{
  cameraUid: string
  id: string
}> {}

export class CameraStreamManager {
  private cameraUid: string
  private cameraStreamStatus: CameraStreamStatus
  private streamSubscribers: StreamSubscribers
  private nanitManager: NanitManager
  private stopStreamAbortController: AbortController | undefined

  static rtmpPath(cameraUid: string, opts: { leadingSlash?: boolean } = {}) {
    return `${opts.leadingSlash ? '/' : ''}${cameraUid}`
  }

  static rtmpUrl(cameraUid: string) {
    return `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${this.rtmpPath(cameraUid)}`
  }

  constructor(nanitManager: NanitManager, cameraUid: string) {
    this.cameraUid = cameraUid
    this.nanitManager = nanitManager
    this.cameraStreamStatus = CameraStreamStatus.DONE_PUBLISHING
    this.streamSubscribers = new StreamSubscribers(cameraUid)
  }

  /* subscribers */

  async addSubscriber(id: string) {
    const added = this.streamSubscribers.addSubscriber(id)

    if (!added) return

    await this.startStream()
  }

  async deleteSubscriber(id: string) {
    const removed = this.streamSubscribers.deleteSubscriber(id)

    if (!removed) return

    const allStatus = this.streamSubscribers.getAllSubscribersStatus()
    if (
      allStatus === StreamSubscriberStatus.DISCONNECTED ||
      allStatus === StreamSubscriberStatus.DONE_PLAYING
    ) {
      await this.scheduleStopStream()
    }
  }

  subscriberPlaying(id: string) {
    this.streamSubscribers.subscriberPlaying(id)
  }

  subscriberDonePlaying(id: string) {
    this.streamSubscribers.subscriberDonePlaying(id)
  }

  /* stream */

  streamPublishing() {
    this.cameraStreamStatus = CameraStreamStatus.PUBLISHING
  }

  streamDonePublishing() {
    this.cameraStreamStatus = CameraStreamStatus.DONE_PUBLISHING
  }

  startStream = memoizeConcurrent(async () => {
    const status = this.cameraStreamStatus
    const debug = {
      cameraUid: this.cameraUid,
      status,
    }

    console.log('[CameraStreamManager] startStream', debug)

    this.cancelScheduledStopStream()

    if (status === CameraStreamStatus.START_REQUESTED) return
    if (status === CameraStreamStatus.START_RESPONDED) return
    if (status === CameraStreamStatus.PUBLISHING) return
    if (status === CameraStreamStatus.STOP_REQUESTED) {
      // wait for stop stream to complete
      try {
        console.log(
          '[CameraStreamManager] startStream: scheduleStopStream: start',
          debug,
        )
        await this.scheduleStopStream()
        console.log(
          '[CameraStreamManager] startStream: scheduleStopStream: success',
          {
            ...debug,
            status: this.cameraStreamStatus,
          },
        )
      } catch (_err: any) {
        // log error but do not throw it
        const err = CameraStreamManagerError.wrap(
          _err,
          'failed to stop stream',
          {
            cameraUid: this.cameraUid,
          },
        )
        console.warn(
          '[CameraStreamManager] startStream: scheduleStopStream: error',
          {
            ...debug,
            status: this.cameraStreamStatus,
            err,
          },
        )
      }
      // fall through
    }
    // STOP_REQUESTED
    // STOP_RESPONDED
    // DONE_PUBLISHING

    const previousStatus = this.cameraStreamStatus
    this.cameraStreamStatus = CameraStreamStatus.START_REQUESTED

    // request start stream
    const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)
    const nanit = this.nanitManager.get()

    try {
      console.log(
        '[CameraStreamManager] startStream: startStreaming: start',
        debug,
      )
      await nanit.startStreaming(this.cameraUid, rtmpUrl)
      console.log(
        '[CameraStreamManager] startStream: startStreaming: success',
        {
          ...debug,
          status: this.cameraStreamStatus,
        },
      )
      this.cameraStreamStatus = CameraStreamStatus.START_RESPONDED
    } catch (_err: any) {
      const err = CameraStreamManagerError.wrap(
        _err,
        'startStream:failed to start stream',
        {
          cameraUid: this.cameraUid,
          cameraStreamStatus: this.cameraStreamStatus,
        },
      )
      if (this.cameraStreamStatus === CameraStreamStatus.START_REQUESTED) {
        this.cameraStreamStatus = previousStatus
      }
      console.warn('[CameraStreamManager] startStream: startStreaming: error', {
        ...debug,
        status: this.cameraStreamStatus,
        err,
      })
      throw err
    }
  })

  stopStream = memoizeConcurrent(
    async ({ force = true }: { force?: boolean } = {}) => {
      const status = this.cameraStreamStatus
      const debug = {
        cameraUid: this.cameraUid,
        status,
      }

      console.log('[CameraStreamManager] stopStream', debug)

      if (status === CameraStreamStatus.STOP_REQUESTED) return
      if (status === CameraStreamStatus.STOP_RESPONDED) return
      if (status === CameraStreamStatus.DONE_PUBLISHING) return
      if (status === CameraStreamStatus.START_REQUESTED) {
        CameraStreamManagerError.assert(force, 'cannot stop while starting')
        // wait for stop stream to complete
        await this.startStream().catch((_err: any) => {
          // log error but do not throw it
          const err = CameraStreamManagerError.wrap(
            _err,
            'stopStream: failed to start stream',
            debug,
          )
          console.warn(err)
        })
        // fall through
      }
      // START_REQUESTED
      // START_RESPONDED
      // PUBLISHING

      const previousStatus = this.cameraStreamStatus
      this.cameraStreamStatus = CameraStreamStatus.STOP_REQUESTED

      // request stop stream
      const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)
      const nanit = this.nanitManager.get()

      try {
        console.log('[CameraStreamManager] stopStream: start', debug)
        await nanit.stopStreaming(this.cameraUid, rtmpUrl)
        console.log('[CameraStreamManager] stopStream: success', debug)
        this.cameraStreamStatus = CameraStreamStatus.STOP_RESPONDED
      } catch (_err: any) {
        const err = CameraStreamManagerError.wrap(
          _err,
          'stopStream: failed to stop stream',
          {
            cameraUid: this.cameraUid,
          },
        )
        if (this.cameraStreamStatus === CameraStreamStatus.STOP_REQUESTED) {
          this.cameraStreamStatus = previousStatus
        }
        console.log('[CameraStreamManager] stopStream: error', {
          ...debug,
          err,
        })
        throw err
      }
    },
  )

  scheduleStopStream = memoizeConcurrent(async () => {
    const debug = {
      cameraUid: this.cameraUid,
      hasAbortController: this.stopStreamAbortController != null,
    }
    console.log('[CameraStreamManager] scheduleStopStream', debug)

    if (this.stopStreamAbortController != null) return

    this.stopStreamAbortController = new AbortController()

    try {
      await timeout(
        NANIT_CAMERA_STOP_DELAY,
        this.stopStreamAbortController.signal,
      )
      console.log('[CameraStreamManager] scheduleStopStream: stopStream', debug)
      await this.stopStream()
      console.log(
        '[CameraStreamManager] scheduleStopStream: stopStream: success',
        debug,
      )
    } catch (_err: any) {
      const err = CameraStreamManagerError.wrap(_err, 'failed to stop stream', {
        cameraUid: this.cameraUid,
      })
      console.warn(
        '[CameraStreamManager] scheduleStopStream: stopStream: error',
        {
          ...debug,
          err,
        },
      )
    } finally {
      this.stopStreamAbortController = undefined
    }
  })

  cancelScheduledStopStream() {
    if (this.stopStreamAbortController == null) return
    this.stopStreamAbortController.abort()
    this.stopStreamAbortController = undefined
  }
}

export default CameraStreamManager
