import AbstractStartable, { state } from 'abstract-startable'
import { NanitManager } from './nanitManager'
import envVar from 'env-var'
import timeout from 'abortable-timeout'
import memoizeConcurrent from 'memoize-concurrent'
import createDeferredPromise, { DeferredPromise } from 'p-defer'
import { assert } from 'console'
import raceAbort from 'race-abort'
const { get } = envVar

const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const NANIT_CAMERA_STOP_DELAY = get('NANIT_CAMERA_STOP_DELAY')
  .default(60 * 1000)
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
      this.cancelDelayedStop('addSubscriber')
      return this.forceStart()
    }
  }

  async deleteSubscriber(subscriberId: string) {
    this.cameraStreamSubscriberIds.delete(subscriberId)

    if (this.cameraStreamSubscriberIds.size === 0) {
      return this.delayedStop()
    }
  }

  publish() {
    if (this.publishingDeferred) {
      console.log('[StreamManager] publish: resolve', {
        cameraUid: this.cameraUid,
      })
      this.publishingDeferred.resolve()
      this.publishingDeferred = null
      return
    }

    // if already "stopped", dont care
    // ("stopping" should technically have donePublishingDeferred above)
    if (this.state === state.STOPPED || this.state === state.STOPPING) {
      console.warn('[StreamManager] publish: unexpected while stopped', {
        cameraUid: this.cameraUid,
        state: this.state,
      })
      this.forceStop().catch((err) => {
        console.error(
          '[StreamManager] publish: unexpected while stopped: force stop error',
          {
            err,
            cameraUid: this.cameraUid,
          },
        )
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
      this.donePublishingDeferred = null
      return
    }

    // if already "stopped", dont care
    // ("stopping" should technically have donePublishingDeferred above)
    if (this.state === 'STOPPED' || this.state === 'STOPPING') {
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

  stopForever = memoizeConcurrent(
    async () => {
      console.log('[StreamManager] stopForever', { cameraUid: this.cameraUid })
      this.stoppedForever = true
      return this.forceStop()
    },
    {
      cacheKey: () => 'all',
    },
  )

  private delayedStop = memoizeConcurrent(
    async () => {
      if (this.delayedStopController) {
        console.log('[StreamManager] delayedStop: already scheduled', {
          cameraUid: this.cameraUid,
        })
        return
      }

      this.delayedStopController = new AbortController()
      console.log('[StreamManager] delayedStop: scheduled', {
        cameraUid: this.cameraUid,
      })
      await timeout(NANIT_CAMERA_STOP_DELAY, this.delayedStopController.signal)
      this.delayedStopController = null
      console.log('[StreamManager] delayedStop: stop now', {
        cameraUid: this.cameraUid,
      })
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
      assert(!this.stoppedForever, 'stopped forever, cannot be restarted')

      console.log('[StreamManager] forceStart', { cameraUid: this.cameraUid })

      if (this.state === state.STOPPING) {
        console.log('[StreamManager] forceStart: wait for stop to complete', {
          cameraUid: this.cameraUid,
        })
        // if force start and stopping, wait for stop to complete, and then start
        await this.stop()
      }

      console.log('[StreamManager] forceStart: start', {
        cameraUid: this.cameraUid,
      })
      return this.start()
    },
    {
      cacheKey: () => 'all',
    },
  )

  private forceStop = memoizeConcurrent(
    async () => {
      console.log('[StreamManager] forceStop', { cameraUid: this.cameraUid })

      if (this.state === state.STARTING && this.publishingDeferred) {
        console.log(
          '[StreamManager] forceStop: starting, dont wait for publishing to begin',
          {
            cameraUid: this.cameraUid,
          },
        )
        this.publishingDeferred.resolve()
        this.publishingDeferred = null
        return this.stop({ force: true })
      }

      if (this.state === state.STOPPING && this.donePublishingDeferred) {
        console.log(
          '[StreamManager] forceStop: stopping, dont wait for publishing to finish',
          {
            cameraUid: this.cameraUid,
          },
        )
        const stopPromise = this.stop({ force: true })
        this.donePublishingDeferred.resolve()
        this.donePublishingDeferred = null
        return stopPromise
      }

      return this.stop({ force: true })
    },
    {
      cacheKey: () => 'all',
    },
  )

  async _start() {
    const nanit = this.nanitManager.get()
    const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)
    const controller = new AbortController()

    this.publishingDeferred = createDeferredPromise()
    await Promise.race([
      timeout(120 * 1000, controller.signal).then(() => {
        const err = new Error('timeout')
        throw err
      }),
      raceAbort(controller.signal, () => {
        this.cameraStreamSubscriberIds.clear()
        return nanit.startStreaming(this.cameraUid, rtmpUrl)
      }).then(() => this.publishingDeferred?.promise),
    ])
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

  async _stop({ force }: { force?: boolean } = { force: false }) {
    this.cancelDelayedStop('stop')

    const nanit = this.nanitManager.get()
    const rtmpUrl = CameraStreamManager.rtmpUrl(this.cameraUid)
    const controller = new AbortController()

    if (!force) this.donePublishingDeferred = createDeferredPromise()
    await Promise.race([
      timeout(120 * 1000, controller.signal).then(() => {
        const err = new Error('timeout')
        throw err
      }),
      raceAbort(controller.signal, () => {
        this.cameraStreamSubscriberIds.clear()
        return nanit.stopStreaming(this.cameraUid, rtmpUrl)
      }).then(() => this.donePublishingDeferred?.promise),
    ])
      .catch((err) => {
        console.warn('[StreamManager] _stop: stopStreaming error', {
          err,
          cameraUid: this.cameraUid,
        })
      })
      .finally(() => {
        this.donePublishingDeferred = null
        controller.abort()
      })
  }
}
