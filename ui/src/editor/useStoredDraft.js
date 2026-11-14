// Drafts and in-flight saves outlive their form: closing a dialog, a board refresh, a
// failed save or a remount keeps them. One in-memory store per connection, profile and
// key, written by async saves even after the form has closed, and read by every view of
// the same key. Cleared only after a confirmed save or an explicit discard.
import { useCallback, useSyncExternalStore } from 'react'

const values = new Map()
const listeners = new Map()

const notify = key => listeners.get(key)?.forEach(listener => listener())

export const readStored = key => values.get(key)

/** Writes `next` (or `next(previous)`) for `key`, mounted or not. */
export function writeStored(key, next) {
  const value = typeof next === 'function' ? next(values.get(key)) : next
  if (value === undefined) values.delete(key)
  else values.set(key, value)
  notify(key)
  return value
}

export const clearStored = key => writeStored(key, undefined)

function subscribe(key, listener) {
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key).add(listener)
  return () => listeners.get(key)?.delete(listener)
}

/** [value, set, discard] for `key`; `init()` seeds an empty key once. */
export function useStoredDraft(key, init) {
  if (!values.has(key) && init) values.set(key, init())
  const value = useSyncExternalStore(
    useCallback(listener => subscribe(key, listener), [key]),
    () => values.get(key)
  )
  const set = useCallback(next => writeStored(key, next), [key])
  const discard = useCallback(() => clearStored(key), [key])
  return [value, set, discard]
}

export const rememberValue = (key, value) => values.set(key, value)
export const recallValue = key => values.get(key)
