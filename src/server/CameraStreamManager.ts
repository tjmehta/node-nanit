import AbstractStartable, {
  StartOptsType,
  state,
  StopOptsType,
} from 'abstract-startable'
import { NanitManager } from './nanitManager'
import envVar from 'env-var'
import timeout from 'abortable-timeout'
import memoizeConcurrent from 'memoize-concurrent'
import createDeferredPromise, { DeferredPromise } from 'p-defer'
import BaseError from 'baseerr'
import { NANIT_REQUEST_TIMEOUT } from '../Nanit'
const { get } = envVar

const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const NANIT_CAMERA_STOP_DELAY = get('NANIT_CAMERA_STOP_DELAY')
  .default(3 * 60 * 1000)
  .asIntPositive()

export class CameraStreamManager extends AbstractStartable {
  private nanitManager: NanitManager
  private cameraUid: string
  private publishingDeferred: DeferredPromise<void> | null = null
  private donePublishingDeferred: DeferredPromise<void> | null = null
  private delayedStopController: AbortController | null = null
  private stoppedForever: boolean = false
  private cameraStreamSubscriberIds = new Set<string>()

  static rtmpUrl(cameraUid: string) {
    return `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
  }

  constructor(nanitManager: NanitManager, cameraUid: string) {
    super()
    this.nanitManager = nanitManager
    this.cameraUid = cameraUid
  }

  rtmpUrl() {
    return CameraStreamManager.rtmpUrl(this.cameraUid)
  }

  async addSubscriber(subscriberId: string) {
    const prevSize = this.cameraStreamSubscriberIds.size
    this.cameraStreamSubscriberIds.add(subscriberId)
    const currSize = this.cameraStreamSubscriberIds.size

    if (currSize > prevSize) {
      console.log('[StreamManager] addSubscriber: one added: forceStart', {
        cameraUid: this.cameraUid,
        id: subscriberId,
        subscriberCount: currSize,
      })
      try {
        await this.start({ force: true })
      } catch (err) {
        this.cameraStreamSubscriberIds.delete(subscriberId)
        console.error(
          '[StreamManager] addSubscriber: one added: forceStart error',
          {
            err,
            cameraUid: this.cameraUid,
            id: subscriberId,
            subscriberCount: this.cameraStreamSubscriberIds.size,
          },
        )

        return Promise.reject(err)
      }
    }
  }

  async deleteSubscriber(subscriberId: string) {
    this.cameraStreamSubscriberIds.delete(subscriberId)

    if (this.cameraStreamSubscriberIds.size === 0) {
      console.log('[StreamManager] deleteSubscriber: none left: delayedStop', {
        cameraUid: this.cameraUid,
        subscriberCount: this.cameraStreamSubscriberIds.size,
      })
      try {
        await this.delayedStop()
      } catch (err) {
        console.error(
          '[StreamManager] deleteSubscriber: none left: delayedStop error',
          {
            err,
            cameraUid: this.cameraUid,
            id: subscriberId,
            subscriberCount: this.cameraStreamSubscriberIds.size,
          },
        )
      }
    } else {
      console.log('[StreamManager] deleteSubscriber: remaining subscribers', {
        cameraUid: this.cameraUid,
        subscriberCount: this.cameraStreamSubscriberIds.size,
      })
    }
  }

  publish() {
    if (this.stoppedForever) return // stopped forever, dont care about publishing state

    if (this.publishingDeferred) {
      console.log('[StreamManager] publish: resolve', {
        cameraUid: this.cameraUid,
      })
      this.publishingDeferred.resolve()
      this.publishingDeferred = null
      return
    }

    // if already "stopped", dont care
    if (this.state === state.STOPPING || this.state === state.STOPPED) {
      console.warn('[StreamManager] publish: unexpected while stopped', {
        cameraUid: this.cameraUid,
        state: this.state,
      })
      return
    }
  }

  donePublish() {
    if (this.stoppedForever) return // stopped forever, dont care about publishing state

    if (this.donePublishingDeferred) {
      // done publishing as expected, after stop was calleds
      console.log('[StreamManager] donePublish: resolve', {
        cameraUid: this.cameraUid,
        subscriberCount: this.cameraStreamSubscriberIds.size,
      })
      this.donePublishingDeferred.resolve()
      this.donePublishingDeferred = null
      return
    }

    // if already "stopped", dont care
    // ("stopping" should technically have donePublishingDeferred above)
    if (this.state === state.STOPPED || this.state === state.STOPPING) {
      console.warn('[StreamManager] donePublish: unexpected while stopped', {
        cameraUid: this.cameraUid,
        state: this.state,
        subscriberCount: this.cameraStreamSubscriberIds.size,
      })
      return
    }

    // TODO: i dont ever see this in logs but maybe this isn't right..
    // finished publishing unexpectedly while streaming
    // this.state === 'STARTED' || this.state === 'STARTING'
    console.warn('[StreamManager] donePublish: unexpected while streaming', {
      cameraUid: this.cameraUid,
      state: this.state,
      subscriberCount: this.cameraStreamSubscriberIds.size,
    })
    if (this.cameraStreamSubscriberIds.size === 0) {
      console.log(
        '[StreamManager] donePublish: unexpected: no subscribers.. stopping later anyways',
        {
          cameraUid: this.cameraUid,
        },
      )
      return
    }

    this.cameraStreamSubscriberIds.clear()
    console.error(
      '[StreamManager] donePublish: unexpected: force stop and start again',
      { cameraUid: this.cameraUid },
    )
    this.stop({ force: true }).catch((err) => {
      console.error(
        '[StreamManager] donePublish: unexpected: force stop error',
        {
          err,
          cameraUid: this.cameraUid,
          subscriberCount: this.cameraStreamSubscriberIds.size,
        },
      )
    })

    return this.start({ force: true })
      .catch((err) => {
        console.error(
          '[StreamManager] donePublish: unexpected: restart error',
          { err, cameraUid: this.cameraUid },
        )
      })
      .then(() => {
        console.warn(
          '[StreamManager] donePublish: unexpected: restart success',
          {
            cameraUid: this.cameraUid,
            subscriberCount: this.cameraStreamSubscriberIds.size,
          },
        )
      })
  }

  stopForever = memoizeConcurrent(
    async () => {
      console.log('[StreamManager] stopForever', { cameraUid: this.cameraUid })
      this.stoppedForever = true
      return this.stop({ force: true })
    },
    {
      cacheKey: () => 'all',
    },
  )

  private delayedStop = memoizeConcurrent(
    async () => {
      console.log('[StreamManager] delayedStop: schedule', {
        cameraUid: this.cameraUid,
      })
      this.delayedStopController = new AbortController()
      await timeout(NANIT_CAMERA_STOP_DELAY, this.delayedStopController.signal)

      console.log('[StreamManager] delayedStop: stop now', {
        cameraUid: this.cameraUid,
      })
      this.delayedStopController = null
      return this.stop()
    },
    {
      cacheKey: () => 'all',
    },
  )

  private cancelDelayedStop(logKey?: string) {
    if (this.delayedStopController) {
      console.log(
        `[StreamManager] ${logKey ?? 'cancelDelayedStop'}: cancel delayed stop`,
        {
          cameraUid: this.cameraUid,
          subscriberCount: this.cameraStreamSubscriberIds.size,
        },
      )
      this.delayedStopController.abort()
      this.delayedStopController = null
    }
  }

  start = memoizeConcurrent(async (opts?: StartOptsType): Promise<void> => {
    BaseError.assert(!this.stoppedForever, 'stopped forever')
    this.cancelDelayedStop('start')
    const p = super.start(opts)
    this.cancelDelayedStop('delayedStop:reset')
    this.delayedStop().catch((err) => {
      console.error('[StreamManager] start: delayedStop: error', {
        err,
      })
    })
    return p
  })

  async _start(opts?: StartOptsType) {
    console.log('[StreamManager] _start: startStreaming', {
      cameraUid: this.cameraUid,
      subscriberCount: this.cameraStreamSubscriberIds.size,
    })

    try {
      const nanit = this.nanitManager.get()
      const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)

      this.publishingDeferred = createDeferredPromise()
      await Promise.race([
        timeout(3 * 60 * 1000, null).then(() => {
          throw new Error('whoa start streaming timeout for 3 minutes!!!!')
        }),
        nanit.startStreaming(this.cameraUid, rtmpUrl),
      ])
      console.log('[StreamManager] _start: startStreaming request success', {
        cameraUid: this.cameraUid,
      })

      await Promise.race([
        timeout(NANIT_REQUEST_TIMEOUT * 2, null).then(() => {
          throw new Error('timeout')
        }),
        this.publishingDeferred.promise,
      ])
      console.log('[StreamManager] _start: startStreaming publish success', {
        cameraUid: this.cameraUid,
      })
    } catch (err) {
      console.error('[StreamManager] _start: startStreaming error', {
        err,
        cameraUid: this.cameraUid,
      })
      throw err
    } finally {
      this.publishingDeferred = null
    }
  }

  stop = memoizeConcurrent(async (opts?: StopOptsType): Promise<void> => {
    this.cancelDelayedStop('stop')
    return super.stop(opts)
  })

  async _stop(opts?: StopOptsType) {
    console.log('[StreamManager] _stop: stopStreaming', {
      cameraUid: this.cameraUid,
      subscriberCount: this.cameraStreamSubscriberIds.size,
    })
    this.cameraStreamSubscriberIds.clear()
    try {
      const nanit = this.nanitManager.get()
      const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)

      if (!opts?.force) this.donePublishingDeferred = createDeferredPromise()

      await nanit.stopStreaming(this.cameraUid, rtmpUrl)
      console.log('[StreamManager] _stop: stopStreaming success', {
        cameraUid: this.cameraUid,
      })

      await this.donePublishingDeferred?.promise
      this.donePublishingDeferred = null
      console.log('[StreamManager] _stop: donePublish success', {
        cameraUid: this.cameraUid,
      })
    } catch (err) {
      // dont throw, just warn
      console.warn('[StreamManager] _stop: error', {
        err,
        cameraUid: this.cameraUid,
      })
    } finally {
      this.donePublishingDeferred = null
    }
  }
}
