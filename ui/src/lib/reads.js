// Reads that survive the host's startup. Pure: no host imports.
//
// `request` (api/client.js) drops an answer when the gateway's activation epoch moved while it
// was in flight, so a late answer can't paint another connection's data. At app start and on
// reload the epoch moves while the very first reads are in flight, on the SAME connection and
// profile, which threw away the board's first good delegation read ("Pickup unavailable" until
// something reread it). A superseded read is repeated while its scope is still the routed one.

/** Runs `read`; repeats it (up to `attempts` in all) when it is superseded but `stillRouted()`. */
export async function readThroughActivation(read, stillRouted, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      const superseded = error?.name === 'SupersededError'
      if (!superseded || attempt >= attempts || !stillRouted()) throw error
    }
  }
}

/**
 * One read at a time per key, and at most one more waiting: `read(key)` asked while one runs
 * shares a single follow-up that starts when the running one ends, so it reflects everything up
 * to the moment it was asked. For a slow read that many things ask for at once (the board after
 * an action): they used to start a read each, and the server ran them one after another.
 */
export function oneAtATime(read) {
  const lanes = new Map()
  return key => {
    const id = JSON.stringify(key)
    const lane = lanes.get(id) ?? { running: null, next: null }
    lanes.set(id, lane)
    const start = () => {
      lane.running = Promise.resolve()
        .then(() => read(key))
        .finally(() => {
          lane.running = null
          if (!lane.next) lanes.delete(id)
        })
      return lane.running
    }
    if (!lane.running) return start()
    if (!lane.next) {
      lane.next = lane.running
        .catch(() => {})
        .then(() => {
          lane.next = null
          return start()
        })
    }
    return lane.next
  }
}
