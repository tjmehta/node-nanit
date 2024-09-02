import AbstractStartable from 'abstract-startable'
import { NanitManager } from './nanitManager'
import envVar from 'env-var'
import timeout from 'abortable-timeout'
import memoizeConcurrent from 'memoize-concurrent'
import createDeferredPromise, { DeferredPromise } from 'p-defer'
import { assert } from 'console'
const { get } = envVar

const RTMP_HOST = get('RTMP_HOST').required().asString()
const RTMP_PORT = get('RTMP_PORT').default(1935).asPortNumber()
const NANIT_CAMERA_STOP_DELAY = get('NANIT_CAMERA_STOP_DELAY')
  .default(60 * 1000)
  .asIntPositive()

export class NanitCameraStreamManager extends AbstractStartable {
  private nanitManager: NanitManager
  private cameraUid: string
  private publishingDeferred: DeferredPromise<void> | null = null
  private donePublishingDeferred: DeferredPromise<void> | null = null
  private delayedStopController: AbortController | null = null
  private stoppedForever: boolean = false

  static rtmpUrl(cameraUid: string) {
    return `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${cameraUid}`
  }

  constructor(nanitManager: NanitManager, cameraUid: string) {
    super()
    this.nanitManager = nanitManager
    this.cameraUid = cameraUid
  }

  publish() {
    if (!this.publishingDeferred) return
    this.publishingDeferred.resolve()
    this.publishingDeferred = null
  }

  donePublish() {
    if (this.stoppedForever) return // stopped forever, dont care about publishing state

    if (this.donePublishingDeferred) {
      // done publishing as expected, after stop was calleds
      this.donePublishingDeferred.resolve()
      this.donePublishingDeferred = null
      return
    }

    // finished publishing unexpectedly
    console.warn('[StreamManager]unexpected done publish')
    this.donePublishingDeferred = createDeferredPromise()
    this.donePublishingDeferred.resolve()
    this.forceStop().catch((err) => {
      console.error(
        'stream stop cleanup failed after unexpected done publish',
        err,
      )
    })
    this.forceStart()
      .then(() => {
        console.error('resume stream success after unexpected done publish')
      })
      .catch((err) => {
        console.error('resume stream failed after unexpected done publish', err)
      })
    return
  }

  forceStart = memoizeConcurrent(
    async () => {
      assert(!this.stoppedForever, 'force stopped, cannot be restarted')
      if (this.delayedStopController) {
        // cancel delayed stop
        this.delayedStopController.abort()
        this.delayedStopController = null
      }

      if (this.state === 'STOPPING') {
        // if force start and stopping, wait for stop to complete, and then start
        await this.stop()
      }

      return this.start()
    },
    {
      cacheKey: () => 'all',
    },
  )

  delayedStop = memoizeConcurrent(
    async () => {
      this.delayedStopController = new AbortController()
      console.log('[StreamManager] delayed stop scheduled', {
        cameraUid: this.cameraUid,
      })
      await timeout(NANIT_CAMERA_STOP_DELAY, this.delayedStopController.signal)
      console.log('[StreamManager] delayed stop now', {
        cameraUid: this.cameraUid,
      })
      return this.stop()
    },
    {
      cacheKey: () => 'all',
    },
  )

  forceStop = memoizeConcurrent(
    async () => {
      console.log('[StreamManager] force stop', { cameraUid: this.cameraUid })
      return this.stop({ force: true })
    },
    {
      cacheKey: () => 'all',
    },
  )

  stopForever = memoizeConcurrent(
    async () => {
      console.log('[StreamManager] stop forever', { cameraUid: this.cameraUid })
      this.stoppedForever = true
      if (this.state === 'STARTING' && this.publishingDeferred) {
        this.publishingDeferred.resolve()
        this.publishingDeferred = null
        return this.stop({ force: true })
      }
      if (this.state === 'STOPPING' && this.donePublishingDeferred) {
        this.donePublishingDeferred.resolve()
        this.donePublishingDeferred = null
        return
      }
      return this.stop({ force: true })
    },
    {
      cacheKey: () => 'all',
    },
  )

  rtmpUrl() {
    return NanitCameraStreamManager.rtmpUrl(this.cameraUid)
  }

  async _start() {
    const nanit = this.nanitManager.get()
    const rtmpUrl = NanitCameraStreamManager.rtmpUrl(this.cameraUid)

    this.publishingDeferred = createDeferredPromise()
    await nanit.startStreaming(this.cameraUid, rtmpUrl)
    await this.publishingDeferred.promise
  }

  async _stop({ force }: { force?: boolean }) {
    if (this.delayedStopController) {
      // cancel delayed stop
      this.delayedStopController.abort()
      this.delayedStopController = null
      // ...and stop immediately
    }

    const nanit = this.nanitManager.get()
    const rtmpUrl = NanitCameraStreamManager.rtmpUrl(this.cameraUid)

    if (this.donePublishingDeferred) {
      // ended early
      this.donePublishingDeferred = null
      await nanit.stopStreaming(this.cameraUid, rtmpUrl)
      return
    }

    this.donePublishingDeferred = createDeferredPromise()
    await nanit.stopStreaming(this.cameraUid, rtmpUrl)
    if (force) return // dont wait for done publishing
    await this.donePublishingDeferred.promise
  }
}
