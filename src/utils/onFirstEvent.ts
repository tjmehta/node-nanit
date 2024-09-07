import { EventEmitter } from 'stream'

type Listener = (...args: any[]) => void

export default function onceFirstEvent<
  E extends EventEmitter,
  K extends string = string,
  Events extends Record<K, Listener> = Record<K, Listener>,
>(ee: E, events: Events) {
  for (const eventName of Object.keys(events)) {
    ee.once(eventName, function (...args) {
      // @ts-ignore maintain this whatever it is
      const self = this
      events[eventName as K].call(self, ...args)
      cleanup()
    })
  }
  function cleanup() {
    for (const eventName of Object.keys(events)) {
      ee.removeListener(eventName, events[eventName as K])
    }
  }
}
