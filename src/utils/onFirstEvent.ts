import { EventEmitter } from 'stream'

type Listener = (...args: any[]) => void

export default function onceFirstEvent<
  E extends EventEmitter,
  Events extends Record<string, Listener> = Record<string, Listener>,
  K extends string = Extract<keyof Events, string>,
>(ee: E, events: Events): () => void {
  const listeners: Record<K, Listener> = {} as Record<K, Listener>

  for (const key in events) {
    const eventName = key as Extract<keyof typeof listeners, string>

    listeners[eventName] = function (...args) {
      // @ts-ignore maintain this whatever it is
      const self = this
      events[eventName].call(self, ...args)
      cleanup()
    }
    ee.once(eventName, listeners[eventName])
  }

  function cleanup() {
    for (const eventName in listeners) {
      ee.removeListener(eventName, listeners[eventName])
    }
  }

  return cleanup
}
