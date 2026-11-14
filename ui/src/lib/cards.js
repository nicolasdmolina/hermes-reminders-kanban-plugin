// Pure presentation helpers for preview cards (reminders_kanban/api/preview-contract.md).
// No host imports here, so node --test can exercise them directly.

export const COLUMNS = ['To do', 'Ready for Agent', 'In progress', 'Needs you', 'Done']

// The leading title labels the backend recognizes (preview-contract.md): the defaults, plus the
// board's own once its envelope names them (Title labels). Longest first, so a label that starts
// with another one wins.
const DEFAULT_LABELS = ['[Agent · Ready]', '[Agent]']
let LABELS = DEFAULT_LABELS

/** Tells splitTitle the board's configured labels ({ agent, ready } from the envelope). */
export function setTitleLabels(labels) {
  const custom = [labels?.ready, labels?.agent].filter(label => typeof label === 'string' && label.trim())
  LABELS = [...new Set([...custom, ...DEFAULT_LABELS])].sort((a, b) => b.length - a.length)
}

/** Splits a source title into its recognized title label and the remaining text. */
export function splitTitle(title) {
  const source = typeof title === 'string' ? title : ''
  const label = LABELS.find(candidate => source.startsWith(candidate)) ?? null
  const rest = label ? source.slice(label.length).trim() : source.trim()
  return { label, text: rest || source.trim() || 'Untitled reminder' }
}

/** Cards grouped into the contract's columns, preserving response order within each. */
export function groupCards(columns, cards) {
  const names = Array.isArray(columns) && columns.length ? columns : COLUMNS
  const groups = new Map(names.map(name => [name, []]))
  for (const card of cards ?? []) {
    const bucket = groups.get(card.column)
    if (bucket) bucket.push(card)
  }
  return names.map(name => ({ name, cards: groups.get(name) }))
}

const pad = value => String(value).padStart(2, '0')

// Building an Intl.DateTimeFormat is slow, and a board formats the same few shapes for every
// card and every past occurrence: one formatter per locale and option set.
const formatters = new Map()
// A formatter fixes the system time zone when it is built. The Mac's zone can change while the
// app stays open (travel): the January and July offsets name the zone cheaply, and a change
// starts the cache over.
let zone = null
const formatter = (locale, options) => {
  const year = new Date().getFullYear()
  const current = `${new Date(year, 0, 1).getTimezoneOffset()}|${new Date(year, 6, 1).getTimezoneOffset()}`
  if (current !== zone) {
    zone = current
    formatters.clear()
  }
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let made = formatters.get(key)
  if (!made) formatters.set(key, (made = new Intl.DateTimeFormat(locale, options)))
  return made
}

/** Due date from native components. Returns null when there is no due date.
 *  All-day dates keep their calendar day; timed dates render in their own zone. */
export function dueInfo(due, now = new Date(), locale = undefined) {
  if (!due || due.year == null || due.month == null || due.day == null) return null
  const allDay = due.hour == null
  const sameYear = due.year === now.getFullYear()
  const dayOpts = { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }
  let date
  let label
  if (allDay) {
    date = new Date(due.year, due.month - 1, due.day)
    label = formatter(locale, dayOpts).format(date)
  } else {
    const iso = `${due.year}-${pad(due.month)}-${pad(due.day)}T${pad(due.hour)}:${pad(due.minute ?? 0)}:00`
    date = zonedDate(iso, due.timeZone)
    label = formatter(locale, { ...dayOpts, hour: 'numeric', minute: '2-digit' }).format(date)
  }
  const endOfDue = allDay ? new Date(due.year, due.month - 1, due.day + 1) : date
  // `near` is the label a card shows: the day by name when it is yesterday, today or tomorrow.
  // Sentences that quote a date ("moved from Nov 4 to Nov 6") keep `label`.
  const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const name = NEAR_DAYS[Math.round((midnight(date) - midnight(now)) / 86_400_000)]
  const near = !name ? label : allDay ? name : `${name}, ${formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(date)}`
  return { allDay, date, label, near, overdue: endOfDue.getTime() < now.getTime() }
}

const NEAR_DAYS = { '-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow' }

// One wall-clock formatter per zone: building one is slow, and every timed card needs it.
const wallClocks = new Map()
const wallClock = timeZone => {
  let made = wallClocks.get(timeZone)
  if (!made) {
    made = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    wallClocks.set(timeZone, made)
  }
  return made
}

// How far the zone's wall clock is ahead of UTC at an instant, in ms.
const offsetAt = (timeZone, instant) => {
  const parts = wallClock(timeZone).formatToParts(new Date(instant))
  const get = type => Number(parts.find(part => part.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant
}

// Interprets a wall-clock time in an IANA zone without a date library. The zone's offset is read
// at a first guess and again at the instant that guess gives: on the day the clocks change the
// two differ, and only the second is the offset the reminder's own time has.
function zonedDate(iso, timeZone) {
  if (!timeZone) return new Date(iso)
  try {
    const wall = new Date(`${iso}Z`).getTime()
    const guess = wall - offsetAt(timeZone, wall)
    return new Date(wall - offsetAt(timeZone, guess))
  } catch {
    return new Date(iso)
  }
}

/** Apple Reminders priority values: 0 none, 1-4 high, 5 medium, 6-9 low. */
export function priorityLabel(priority) {
  if (!priority) return null
  if (priority <= 4) return 'High'
  if (priority === 5) return 'Medium'
  return 'Low'
}

const UNITS = ['day', 'week', 'month', 'year']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Short English summary of native recurrence rules, e.g. "Every 2 weeks on Mon, Thu". */
export function repeatSummary(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const rule = rules[0]
  const unit = UNITS[rule.frequency] ?? 'period'
  const interval = rule.interval > 1 ? rule.interval : 1
  let text = interval === 1 ? (unit === 'day' ? 'Daily' : `${capital(unit)}ly`) : `Every ${interval} ${unit}s`
  if (unit === 'day' && interval === 1) text = 'Daily'
  const days = (rule.weekdays ?? []).map(entry => WEEKDAYS[(entry.day ?? 1) - 1]).filter(Boolean)
  if (days.length) text += ` on ${days.join(', ')}`
  if (rule.endCount) text += `, ${rule.endCount} ${rule.endCount === 1 ? 'time' : 'times'}`
  else if (rule.endDate) text += `, until ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(rule.endDate))}`
  if (rules.length > 1) text += ` (+${rules.length - 1} more)`
  return text
}

const capital = word => word.charAt(0).toUpperCase() + word.slice(1)

/** Ready tasks the contract counts as eligible after a future activation. */
export const importedReady = cards => (cards ?? []).filter(card => card.imported_ready && card.column !== 'Done')

/** Board header subtitle: the selected list names in source order. */
export function selectedListNames(envelope) {
  const ids = envelope?.setup?.selected_list_ids ?? []
  const byId = new Map((envelope?.lists ?? []).map(list => [list.id, list.title]))
  const fromCards = new Map((envelope?.cards ?? []).map(card => [card.source?.calendarId, card.source?.calendarTitle]))
  return ids.map(id => byId.get(id) ?? fromCards.get(id) ?? 'Unavailable list')
}

// ── Done column: the window itself comes from POST /view (ui/src/lib/views.js) ──

/** "Today", "Yesterday", a weekday within the week, else a date (year only when it differs). */
export function completedLabel(iso, now = new Date(), locale = undefined) {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (Number.isNaN(time)) return null
  const date = new Date(time)
  const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return formatter(locale, { weekday: 'short' }).format(date)
  const sameYear = date.getFullYear() === now.getFullYear()
  return formatter(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(date)
}
