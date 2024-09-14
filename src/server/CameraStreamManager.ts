import AbstractStartable, {
  StartOptsType,
  state,
  StopOptsType,
} from 'abstract-startable'
import timeout from 'abortable-timeout'
import memoizeConcurrent from 'memoize-concurrent'
import createDeferredPromise, { DeferredPromise } from 'p-defer'
import envVar from 'env-var'
import Nanit from '..'
const { get } = envVar

const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const NANIT_CAMERA_STOP_DELAY = get('NANIT_CAMERA_STOP_DELAY')
  .default(60 * 1000)
  .asIntPositive()

enum Op {
  Start,
  Stop,
}

export class CameraStreamManager extends AbstractStartable<StartOptsType> {
  private nanit: Nanit
  private cameraUid: string
  private publishingDeferred: DeferredPromise<void> | null = null
  private donePublishingDeferred: DeferredPromise<void> | null = null
  private delayedStopController: AbortController | null = null
  private stoppedForever: boolean = false
  private cameraStreamSubscriberIds = new Set<string>()

  static rtmpUrl(cameraUid: string) {
    return `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
  }

  constructor(nanit: Nanit, cameraUid: string) {
    super()
    this.nanit = nanit
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
        subscriberCount: currSize,
        cameraUid: this.cameraUid,
      })
      return this.forceStart()
    }
  }

  async deleteSubscriber(subscriberId: string) {
    this.cameraStreamSubscriberIds.delete(subscriberId)

    if (this.cameraStreamSubscriberIds.size === 0) {
      console.log('[StreamManager] deleteSubscriber: none left: delayedStop', {
        cameraUid: this.cameraUid,
        subscriberCount: this.cameraStreamSubscriberIds.size,
      })
      this.delayedStop().catch((err) => {
        console.error(
          '[StreamManager] deleteSubscriber: none left: delayedStop error',
          {
            err,
            cameraUid: this.cameraUid,
            subscriberCount: this.cameraStreamSubscriberIds.size,
          },
        )
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
      })
      this.donePublishingDeferred.resolve()
      return
    }

    // if already "stopped", dont care
    // ("stopping" should technically have donePublishingDeferred above)
    if (this.state === state.STOPPED || this.state === state.STOPPING) {
      console.warn('[StreamManager] donePublish: unexpected while stopped', {
        cameraUid: this.cameraUid,
        state: this.state,
      })
      return
    }

    // finished publishing unexpectedly while streaming
    // this.state === 'STARTED' || this.state === 'STARTING'
    console.warn('[StreamManager] donePublish: unexpected while streaming')
    this.forceStop()
      .catch((err) => {
        console.error(
          '[StreamManager] donePublish: unexpected: force stop error',
          { err, cameraUid: this.cameraUid },
        )
      })
      .then(() => {
        return this.forceStart()
      })
      .then(() => {
        console.warn(
          '[StreamManager] donePublish: unexpected: restart success',
          {
            cameraUid: this.cameraUid,
          },
        )
      })
      .catch((err) => {
        console.error(
          '[StreamManager] donePublish: unexpected: restart error',
          { err, cameraUid: this.cameraUid },
        )
      })
  }

  // stopForever = memoizeConcurrent(
  //   async () => {
  //     console.log('[StreamManager] stopForever', { cameraUid: this.cameraUid })
  //     this.stoppedForever = true
  //     return this.forceStop()
  //   },
  //   {
  //     cacheKey: () => 'all',
  //   },
  // )

  private delayedStop = memoizeConcurrent(
    async () => {
      if (this.delayedStopController) {
        console.log('[StreamManager] delayedStop: already scheduled', {
          cameraUid: this.cameraUid,
        })
        return
      }

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
        },
      )
      this.delayedStopController.abort()
      this.delayedStopController = null
    }
  }

  private forceStart = memoizeConcurrent(
    async () => {
      this.start({ force: true })
    },
    {
      cacheKey: () => 'all',
    },
  )

  private forceStop = memoizeConcurrent(
    async () => {
      return this.stop({ force: true })
    },
    {
      cacheKey: () => 'all',
    },
  )

  async start(opts?: StartOptsType): Promise<void> {
    this.cancelDelayedStop('start')
    console.log('[StreamManager] start', {
      cameraUid: this.cameraUid,
      state: this.state,
      opts,
    })

    if (opts?.force && this.donePublishingDeferred) {
      this.donePublishingDeferred.reject(new Error('aborted'))
    }

    return super.start(opts)
  }

  async _start(opts?: StartOptsType) {
    const nanit = this.nanit
    const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)
    const controller = new AbortController()

    this.publishingDeferred = createDeferredPromise()

    console.log('[StreamManager] _start: startStreaming', {
      cameraUid: this.cameraUid,
    })
    return nanit
      .startStreaming(this.cameraUid, rtmpUrl)
      .then(() => {
        console.log('[StreamManager] _start: startStreaming request success', {
          cameraUid: this.cameraUid,
        })
      })
      .then(() => this.publishingDeferred?.promise)
      .then(() => {
        console.log('[StreamManager] _start: startStreaming publish success', {
          cameraUid: this.cameraUid,
        })
      })
      .catch((err) => {
        console.error('[StreamManager] _start: startStreaming error', {
          err,
          cameraUid: this.cameraUid,
        })
        throw err
      })
      .finally(() => {
        this.publishingDeferred = null
        controller.abort()
      })
  }

  async stop(opts?: StopOptsType): Promise<void> {
    this.cancelDelayedStop('stop')
    console.log('[StreamManager] stop', {
      cameraUid: this.cameraUid,
      state: this.state,
      opts,
    })

    if (opts?.force && this.publishingDeferred) {
      this.publishingDeferred.reject(new Error('aborted'))
    }

    return super.stop(opts)
  }

  async _stop(opts?: StopOptsType) {
    const nanit = this.nanit
    const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)
    const controller = new AbortController()

    if (!opts?.force) this.donePublishingDeferred = createDeferredPromise()

    console.log('[StreamManager] _stop: stopStreaming', {
      cameraUid: this.cameraUid,
    })
    return nanit
      .stopStreaming(this.cameraUid, rtmpUrl)
      .then(() => {
        console.log('[StreamManager] _stop: stopStreaming request success', {
          cameraUid: this.cameraUid,
        })
      })
      .then(() => this.donePublishingDeferred?.promise)
      .then(() => {
        console.log(
          '[StreamManager] _stop: stopStreaming donePublishing success',
          {
            cameraUid: this.cameraUid,
          },
        )
      })
      .catch((err) => {
        console.warn('[StreamManager] _stop: stopStreaming error', {
          err,
          cameraUid: this.cameraUid,
        })
        // dont throw, just warn
      })
      .finally(() => {
        this.cameraStreamSubscriberIds.clear()
        this.donePublishingDeferred = null
        controller.abort()
      })
  }
}
