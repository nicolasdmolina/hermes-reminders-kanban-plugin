import { ACCESS } from './access.js'
// The stable task link and its resolver response, as data the task view renders.
// Pure: no host imports. Contracts: reminders_kanban/api/task-links-contract.md
// (resolver) and attention-contract.md / delegation-contract.md (actions).

/** Browser page every minted link opens (the dashboard plugin route). */
export const TASK_PAGE = '/reminders'
const API_PATH = /\/api\/plugins\/reminders-kanban\/task-links\/([^/?#]+)\/([^/?#]+)\/?$/

const clean = value => (typeof value === 'string' && /^[A-Za-z0-9._~-]{1,200}$/.test(value) ? value : null)

/**
 * Reads a task destination from a link URL (page or the older JSON resource path).
 * Returns { owner, link, profile, occurrence, url } or null. Never trusts the origin:
 * the destination is resolved by whichever host the user is signed in to.
 */
export function parseTaskLink(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let url
  try {
    url = new URL(value.trim(), 'https://link.invalid')
  } catch {
    return null
  }
  let owner = null
  let link = null
  const api = API_PATH.exec(url.pathname)
  if (api) {
    owner = clean(safeDecode(api[1]))
    link = clean(safeDecode(api[2]))
  } else if (url.pathname.replace(/\/+$/, '').endsWith(TASK_PAGE)) {
    owner = clean(url.searchParams.get('owner'))
    link = clean(url.searchParams.get('link'))
  }
  if (!owner || !link) return null
  return {
    owner,
    link,
    profile: clean(url.searchParams.get('profile')) ?? 'default',
    occurrence: clean(url.searchParams.get('occurrence')),
    url: value.trim()
  }
}

/**
 * What the browser page at `href` should show: { kind: 'task', dest } for a task link,
 * { kind: 'no_task' } when the address names no task at all (the bare page: the browser opens
 * one task from its reminder's link and serves no board), else { kind: 'not_found' } for a
 * link that names a task but can't be read.
 */
export function pageEntry(href) {
  const dest = parseTaskLink(href)
  if (dest) return { kind: 'task', dest }
  let url = null
  try {
    url = new URL(String(href ?? '').trim(), 'https://link.invalid')
  } catch {
    return { kind: 'not_found' }
  }
  const named = url.searchParams.has('owner') || url.searchParams.has('link') || API_PATH.test(url.pathname)
  return { kind: named ? 'not_found' : 'no_task' }
}

/** The bare browser page: not an error, just how to get to a task. */
export const NO_TASK = {
  title: 'Open a task from its reminder',
  body: "This page shows one task at a time. Use the Open in Hermes link in the reminder's notes."
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

// "Only on this Mac" writes no link: its claim line names the Mac and the task instead.
// "(ref <owner>.<link>.<start>)": the first eight hex digits of the install id and of the task's
// link id, and when the run first claimed the reminder (seconds, base 36). A person's take over
// adds "~<owner taken from>[~<count>]". The earlier form (full ids, ", from <id>", ", take <n>")
// still reads.
const LOCAL_CLAIM = /^In Hermes on (.+) \(ref ([0-9A-Fa-f]{8})\.([0-9A-Fa-f]{8})\.([0-9a-z]{1,10})(?:~([0-9A-Fa-f]{8})(?:~\d+)?)?\)\s*$/
const LOCAL_CLAIM_OLD = /^In Hermes on (.+) \(ref ([0-9A-Fa-f-]{36})\.([0-9A-Fa-f-]{36})(?:, from ([0-9A-Fa-f-]{36}))?(?:, take \d+)?\)\s*$/
const start36 = text => (/^[0-9a-z]{1,10}$/.test(text ?? '') ? parseInt(text, 36) : 0)

// The Mac that wrote a link: its `mac` field, else (an older link) its address's first label.
function linkMac(value) {
  try {
    const url = new URL(value)
    const named = (url.searchParams.get('mac') ?? '').trim().replace(/\s+/g, ' ')
    if (named) return named
    // A bare address (an IP, or a numeric label) names nobody.
    const label = url.hostname.split('.')[0]
    return !label || /^[\d[]/.test(label) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') ? 'another Mac' : label
  } catch {
    return 'another Mac'
  }
}

function linkStart(value) {
  try {
    return start36(new URL(value).searchParams.get('t'))
  } catch {
    return 0
  }
}

function linkFrom(value) {
  try {
    return clean(new URL(value).searchParams.get('from'))
  } catch {
    return null
  }
}

/**
 * Every claim in a reminder's notes, in order: [{ owner, link, mac, url, start, from }]. A claim is the line a
 * Hermes writes to say it has the reminder (reminders_kanban/claims.py): the task link
 * ("Open in Hermes: <link>", url set) or, with no link address, "In Hermes on <Mac> (ref
 * <owner>.<link>.<start>)" (url null). owner is the install and link its task, as written (the
 * compact line carries their first eight hex digits); start is when the run first claimed the
 * reminder (0 on lines from before it was written); from is the install a person's Take over
 * took the reminder from, else null.
 */
export function claims(notes) {
  const found = []
  for (const line of String(notes ?? '').split('\n')) {
    const local = LOCAL_CLAIM.exec(line)
    const old = local ? null : LOCAL_CLAIM_OLD.exec(line)
    if (local || old) {
      const [, mac, owner, link] = local ?? old
      found.push({ owner: owner.toLowerCase(), link: link.toLowerCase(), mac: mac.trim().replace(/\s+/g, ' '), url: null, start: local ? start36(local[4]) : 0, from: (local ? local[5] : old[4])?.toLowerCase() ?? null })
      continue
    }
    for (const match of line.matchAll(/Open in Hermes: (\S+)/g)) {
      const dest = parseTaskLink(match[1])
      if (dest) found.push({ owner: dest.owner, link: dest.link, mac: linkMac(match[1]), url: match[1], start: linkStart(match[1]), from: linkFrom(match[1]) })
    }
  }
  return found
}

/** The task link on a reminder: its URL field, else the "Open in Hermes:" line in notes. */
export function taskLinkOf(source) {
  if (!source) return null
  const fromUrl = parseTaskLink(source.url)
  if (fromUrl) return fromUrl
  const lines = String(source.notes ?? '').match(/Open in Hermes: (\S+)/g) ?? []
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = parseTaskLink(lines[i].slice('Open in Hermes: '.length))
    if (found) return found
  }
  return null
}

/**
 * A task destination from its stored binding (a delegation or occurrence row's `destination`:
 * { owner_id, link_id, url }), for a task whose reminder carries no written link. "Only on this
 * Mac" writes none, and a link may not be written yet. The binding belongs to the routed profile
 * that returned the row. Returns { owner, link, profile, occurrence: null, url } (url may be null)
 * or null when the binding doesn't name a task.
 */
export function bindingDest(destination, profile) {
  const owner = clean(destination?.owner_id)
  const link = clean(destination?.link_id)
  if (!owner || !link) return null
  const url = typeof destination.url === 'string' && destination.url.trim() ? destination.url.trim() : null
  return { owner, link, profile: clean(profile) ?? 'default', occurrence: null, url }
}

/** The stored binding of a board card's own task: its delegation row's, else its occurrence's.
 *  None for a reminder that only carries a copy of another reminder's link (story 60). */
export function cardBinding(card) {
  if (!card || card.linkCopy) return null
  const destination = (card.agent?.row?.destination ?? card.finishedDestination) ?? card.occurrence?.destination ?? null
  return bindingDest(destination, 'default') ? destination : null
}

/** A card has a Hermes task of this Mac's when its own row carries the stored binding, or its
 *  reminder carries a task link. A link another Mac's Hermes wrote (`claim: 'foreign'`) names no
 *  task here: such a reminder opens as plain details, never as "belongs to a different Hermes". */
export const hasHermesTask = card => Boolean(card && (cardBinding(card) || (card.claim !== 'foreign' && taskLinkOf(card.source))))

/** A card's task destination: the link written on its reminder, else its stored binding. */
export function cardDest(card, profile) {
  if (!card) return null
  return taskLinkOf(card.source) ?? bindingDest(cardBinding(card), profile)
}

/** Reminder notes without the generated claim line ("Open in Hermes: <task link>", or "In Hermes
 *  on <Mac> (ref ...)"), for views that already say whose task it is. Only a whole line holding a
 *  valid claim is left out; other text stays. */
export function notesWithoutLink(notes) {
  const generated = line => {
    if (LOCAL_CLAIM.test(line) || LOCAL_CLAIM_OLD.test(line)) return true
    const match = /^Open in Hermes: (\S+)\s*$/.exec(line)
    return Boolean(match && parseTaskLink(match[1]))
  }
  return String(notes ?? '')
    .split('\n')
    .filter(line => !generated(line))
    .join('\n')
    .trimEnd()
}

/** Whether two snapshots of one reminder differ only by a claim line (and the modified time a
 *  claim write leaves): the reminder is otherwise what the person last saw. */
export function onlyClaimChanged(before, after) {
  if (!before || !after || before.id !== after.id) return false
  const plain = source => JSON.stringify({ ...source, notes: notesWithoutLink(source.notes) || null, modified: null })
  return before.notes !== after.notes && plain(before) === plain(after)
}

/** Backend path of the resolver for this destination (relative to the plugin API root). */
export function resolverPath(dest, occurrence = dest.occurrence) {
  const query = new URLSearchParams({ profile: dest.profile })
  if (occurrence) query.set('occurrence', occurrence)
  return `/task-links/${encodeURIComponent(dest.owner)}/${encodeURIComponent(dest.link)}?${query}`
}

/** Page URL (path + query) for the same destination, e.g. after choosing an occurrence. */
export function pagePath(dest, occurrence = dest.occurrence) {
  const query = new URLSearchParams({ owner: dest.owner, link: dest.link, profile: dest.profile })
  if (occurrence) query.set('occurrence', occurrence)
  return `${TASK_PAGE}?${query}`
}

const STATES = {
  question: { label: 'Needs your reply', tone: 'attention' },
  result: { label: 'Result ready', tone: 'attention' },
  failed: { label: 'Stopped before finishing', tone: 'danger' },
  paused: { label: 'Paused', tone: 'muted' },
  active: { label: 'Working', tone: 'active' },
  ready: { label: 'Queued', tone: 'muted' },
  stopped: { label: 'Stopped', tone: 'muted' },
  done: { label: 'Done', tone: 'done' }
}

export const stateInfo = state => STATES[state] ?? { label: 'Unknown', tone: 'muted' }

/** Problem screens. Titles name the problem, actions name the recovery. */
export const LINK_PROBLEMS = {
  sign_in: {
    title: 'Sign in to open this task',
    body: 'This Hermes needs you to sign in. Your link and draft are kept.',
    action: 'Sign in'
  },
  wrong_owner: {
    title: 'This task belongs to a different Hermes',
    body: 'Open the link from the Hermes that created it.',
    action: null
  },
  wrong_profile: {
    title: 'This task belongs to another profile',
    body: 'Switch to the {profile} profile to open it.',
    action: null
  },
  not_found: {
    title: 'Task not found',
    body: 'It was removed, or the link is broken.',
    action: null
  },
  unavailable: {
    title: "Can't reach this task's Hermes",
    body: 'Hermes is not answering. Your link and draft are kept.',
    action: 'Try again'
  },
  backend_missing: {
    title: 'Reminders Kanban is off for this profile',
    body: 'Turn on the Reminders Kanban plugin for this profile, then try again.',
    action: 'Try again'
  }
}

/** Maps a failed request (host "<status>: <body>" error or a fetch failure) to a problem kind. */
export function classifyLinkError(error) {
  if (error?.name === 'SupersededError') return 'superseded'
  const message = String(error?.message ?? error ?? '')
  const status = Number(error?.statusCode) || Number(/^(\d{3}):/.exec(message)?.[1]) || null
  if (status === 401 || status === 403) return 'sign_in'
  if (status === 404 || /got HTML|endpoint is likely missing/i.test(message)) return 'backend_missing'
  return 'unavailable'
}

const newestFirst = (a, b) => (b.started_at ?? b.created_at ?? 0) - (a.started_at ?? a.created_at ?? 0) || (b.id ?? 0) - (a.id ?? 0)
const OWN_AUTHOR = 'reminders-kanban:'
// Ticket 16's receipt, written by the owner before a new attempt (recovery-<run>): not your words.
const RECOVERY_AUTHOR = 'reminders-kanban:recovery-'

/**
 * Turns a resolver response into what the task view shows.
 * { kind: 'resolved' | problem kind, ...details }. The current question or result
 * comes first; history (attempts and comments) follows, newest first.
 */
export function taskView(response) {
  const status = response?.status
  if (status === 'sign_in_required') return { kind: 'sign_in' }
  if (status === 'wrong_owner') return { kind: 'wrong_owner' }
  if (status === 'not_found') return { kind: 'not_found' }
  if (status !== 'resolved') return { kind: 'unavailable' }

  const state = response.state
  const attempts = [...(response.attempts ?? [])].sort(newestFirst).map((run, index, all) => ({
    id: run.id,
    number: all.length - index,
    outcome: run.outcome ?? (run.status === 'running' ? 'running' : (run.status ?? null)),
    // The host's own approval step when a person accepts; it carries no worker output.
    accepted: run.metadata?.approval === 'manual',
    summary: run.summary ?? null,
    error: run.error ?? null,
    startedAt: run.started_at ?? null,
    endedAt: run.ended_at ?? null,
    sessionId: run.session_id ?? null
  }))
  const comments = [...(response.comments ?? [])].sort(newestFirst).map(comment => ({
    id: comment.id,
    body: comment.body ?? '',
    at: comment.created_at ?? null,
    recovery: String(comment.author ?? '').startsWith(RECOVERY_AUTHOR),
    fromYou: (String(comment.author ?? '').startsWith(OWN_AUTHOR) && !String(comment.author ?? '').startsWith(RECOVERY_AUTHOR)) || comment.author === 'user',
    // A worker's own notes (kanban_comment) carry its profile as author: they are Hermes speaking.
    fromHermes: Boolean(response.binding?.profile) && comment.author === response.binding.profile
  }))
  const current =
    state === 'question' && response.question
      ? { kind: 'question', text: response.question }
      : state === 'result' || state === 'done'
        ? response.result
          ? { kind: 'result', text: response.result }
          : null
        : null
  const occurrences = (response.occurrence_ids ?? []).map(id => ({
    id,
    current: id === response.current_occurrence_id,
    selected: id === response.selected_occurrence_id
  }))
  return {
    kind: 'resolved',
    state,
    info: stateInfo(state),
    taskId: response.binding?.task ?? null,
    profile: response.binding?.profile ?? null,
    historical: Boolean(response.historical),
    currentOccurrence: response.current_occurrence_id ?? null,
    selectedOccurrence: response.selected_occurrence_id ?? null,
    occurrences,
    actions: response.historical ? [] : (response.actions ?? []),
    current,
    attempts,
    comments
  }
}

// What a run said in the conversation: its question or result. Other outcomes are activity lines.
const SPOKEN = { blocked: 'question', needs_input: 'question', review_requested: 'result', completed: 'result' }
// A run that ended without speaking, as one short activity line (its duration goes in the meta).
const ENDED = {
  failed: { label: 'Stopped before finishing', glyph: 'warning' },
  crashed: { label: 'Stopped before finishing', glyph: 'warning' },
  timed_out: { label: 'Ran out of time', glyph: 'warning' },
  rate_limited: { label: 'Waited for capacity', glyph: 'watch' },
  reclaimed: { label: 'Stopped', glyph: 'stop' },
  archived: { label: 'Stopped', glyph: 'stop' }
}

/** Core chat's elapsed format (components/chat/activity-timer.ts formatElapsed): "12s", "2:10". */
export function formatElapsed(seconds) {
  const whole = Math.max(0, Math.floor(seconds))
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** A finished run, as core labels a finished turn ("Thought for 12s", "Thought briefly"). */
export function workedLabel(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'Worked'
  return seconds < 1 ? 'Worked briefly' : `Worked for ${formatElapsed(seconds)}`
}

const duration = attempt =>
  Number.isFinite(attempt.startedAt) && Number.isFinite(attempt.endedAt) ? attempt.endedAt - attempt.startedAt : null

/**
 * The task as a conversation, oldest first, in core chat's anatomy: quiet left-aligned activity
 * lines ({ type: 'activity', label, glyph, meta, at }) for what Hermes did, Hermes messages
 * ({ type: 'hermes', kind: 'question' | 'result', text, at, current }), your replies
 * ({ type: 'you', text, at }) and other comments ({ type: 'comment', text, at }). Each finished run
 * is one activity line ("Worked for 12s" before what it said, or how it ended). The run still going
 * is not an item: liveActivity() says what to show for it. The current question or result appears
 * once, as the last Hermes message. Hermes' internal run text never shows.
 */
export function threadOf(view) {
  if (view?.kind !== 'resolved') return []
  const items = []
  const attempts = [...view.attempts].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id ?? 0) - (b.id ?? 0))
  for (const attempt of attempts) {
    const end = attempt.endedAt ?? attempt.startedAt
    if (attempt.accepted) {
      items.push({ type: 'activity', label: 'Accepted', glyph: 'check', meta: null, at: end })
      continue
    }
    // Still running: shown live, not as a settled line.
    if (attempt.outcome === 'running' || attempt.endedAt == null) continue
    const seconds = duration(attempt)
    if (SPOKEN[attempt.outcome] && attempt.summary) {
      items.push({ type: 'activity', label: workedLabel(seconds), glyph: null, meta: null, at: attempt.startedAt ?? end })
      items.push({ type: 'hermes', kind: SPOKEN[attempt.outcome], text: attempt.summary, at: end })
    } else if (SPOKEN[attempt.outcome]) {
      items.push({ type: 'activity', label: workedLabel(seconds), glyph: null, meta: null, at: attempt.startedAt ?? end })
    } else if (ENDED[attempt.outcome]) {
      const ended = ENDED[attempt.outcome]
      items.push({ type: 'activity', label: ended.label, glyph: ended.glyph, meta: seconds != null && seconds >= 1 ? formatElapsed(seconds) : null, at: end, runId: attempt.id ?? null })
    }
  }
  // view.comments is newest first; a thread reads oldest first, and ids break same-second ties.
  const comments = [...view.comments].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id ?? 0) - (b.id ?? 0))
  for (const comment of comments) {
    if (comment.recovery) items.push({ type: 'activity', label: 'Checked what the last attempt did', glyph: 'search', meta: null, at: comment.at })
    else if (comment.fromHermes) items.push({ type: 'hermes', kind: 'note', text: comment.body, at: comment.at })
    else items.push({ type: comment.fromYou ? 'you' : 'comment', text: comment.body, at: comment.at })
  }
  // Stable by time: a run's activity line stays before its message when they share a second.
  const ordered = items.map((item, index) => ({ item, index })).sort((a, b) => (a.item.at ?? 0) - (b.item.at ?? 0) || a.index - b.index).map(entry => entry.item)
  if (view.current) {
    const last = ordered.findLastIndex(item => item.type === 'hermes' && item.text === view.current.text)
    if (last === -1) ordered.push({ type: 'hermes', kind: view.current.kind, text: view.current.text, at: null, current: true })
    else ordered[last] = { ...ordered[last], current: true }
  }
  return markAttempts(ordered)
}

/**
 * History across attempts: a message of yours that answers a result is a change request
 * (asks: 'changes'; a reply answers a question). When the task has delivered more than once, each
 * result says whether it is the latest (`latest`) or was revised later (`earlier`).
 */
function markAttempts(items) {
  let lastHermes = null
  const marked = items.map(item => {
    if (item.type === 'hermes') lastHermes = item
    if (item.type === 'you' && lastHermes?.kind === 'result') return { ...item, asks: 'changes' }
    return item
  })
  const results = marked.filter(item => item.type === 'hermes' && item.kind === 'result')
  if (results.length < 2) return marked
  const latest = results.at(-1)
  return marked.map(item => (item.type === 'hermes' && item.kind === 'result' ? { ...item, round: item === latest ? 'latest' : 'earlier' } : item))
}

/**
 * The live line under the thread, or null: { kind, label, since }.
 * working: Hermes is running now (shimmering label, timer from the run's start, epoch seconds);
 * queued: waiting to run (queuedLabel, the board's wait reason when it knows one; `queued` says the
 *   board's queue holds it, which wins over Hermes' parked state, reported as paused);
 * paused: nothing runs until you act; stopped: shown only when no run already says so.
 */
export function liveActivity(view, { queued = false, queuedLabel = 'Waiting for a free slot', pausedLabel = null } = {}) {
  if (view?.kind !== 'resolved') return null
  // The board's queue wins over Hermes' parked (scheduled → paused) state: it is waiting, not paused.
  if (queued && (view.state === 'ready' || view.state === 'paused')) return { kind: 'queued', label: queuedLabel, since: null }
  const running = view.attempts.find(attempt => attempt.outcome === 'running' && attempt.endedAt == null)
  if (view.state === 'active') return { kind: 'working', label: 'Working', since: running?.startedAt ?? null }
  if (view.state === 'ready') return { kind: 'queued', label: queuedLabel, since: null }
  // pausedLabel: what the board knows paused it ("Due date moved from Nov 7 to Nov 8").
  if (view.state === 'paused') return { kind: 'paused', label: pausedLabel ?? 'Paused', since: null }
  if (view.state === 'stopped') {
    const said = view.attempts.some(attempt => ENDED[attempt.outcome]?.label === 'Stopped')
    return said ? null : { kind: 'stopped', label: 'Stopped', since: null }
  }
  return null
}

const copiesOf = (thread, text) => thread.filter(item => item.type === 'you' && item.text.trim() === text).length

/** What you send, plus how many of your messages already said the same thing (for pendingReply). */
export function sentReply(text, thread) {
  const trimmed = text.trim()
  return { text: trimmed, seen: copiesOf(thread, trimmed) }
}

/**
 * What you just sent (from sentReply), still waiting to appear in the task: the text to show as a
 * pending message, or null once the thread holds a new copy of it (or nothing was sent). Counting
 * copies keeps a repeated answer ("Yes" twice) pending until its own comment arrives.
 */
export function pendingReply(sent, thread) {
  if (!sent?.text) return null
  return copiesOf(thread, sent.text) > (sent.seen ?? 0) ? null : sent.text
}

/**
 * A submission kept for retry (its answer never arrived) once the task has moved on to another
 * question: its key can't be replayed, so it is dropped. `clear`: the thread already holds that
 * reply (Hermes settled it), so the box doesn't offer it again as a draft for the new question.
 * `submission.seen`: how many of your messages already said the same when it was sent.
 */
export function settledSubmission(submission, token, text, thread) {
  if (!submission?.key || !token || submission.token === token) return null
  return { clear: String(text ?? '').trim() === submission.text && copiesOf(thread, submission.text) > (submission.seen ?? 0) }
}

// Links in plain message text, for the browser page (it has no markdown renderer): Markdown
// [label](https://…) links and bare https:// URLs, keeping one level of balanced parentheses
// (…/Mercury_(planet)). Returns text and { href, label } parts in order.
const URL_CHAR = String.raw`[^\s<>()\x60*]|\([^\s<>()\x60*]*\)`
const LINKS = new RegExp(
  String.raw`\[([^\]\n]+)\]\((https?:\/\/(?:${URL_CHAR})+)\)|(https?:\/\/(?:${URL_CHAR})*(?:[^\s<>().,;:!?'"\x60*]|\([^\s<>()\x60*]*\)))`,
  'g'
)
export function linkParts(text) {
  const parts = []
  let at = 0
  for (const match of String(text ?? '').matchAll(LINKS)) {
    if (match.index > at) parts.push(text.slice(at, match.index))
    parts.push(match[2] ? { href: match[2], label: match[1] } : { href: match[3], label: match[3] })
    at = match.index + match[0].length
  }
  if (at < String(text ?? '').length) parts.push(String(text).slice(at))
  return parts
}

/** Which input the current state takes from a person: reply, review, or nothing. */
export function inputMode(view) {
  if (view?.kind !== 'resolved' || view.historical) return null
  if (view.state === 'question' && view.actions.includes('comment')) return 'reply'
  if (view.state === 'result' && view.actions.includes('accept')) return 'review'
  return null
}

/** Picks the attention entry (with its submission token) for this task from GET /attention. */
export function attentionFor(feed, taskId) {
  // Only setup_required means replies aren't set up; any other answer is a read that failed.
  if (!feed || feed.status !== 'ok' || !taskId) return { available: false, failed: Boolean(feed && taskId && feed.status !== 'setup_required'), token: null, entry: null }
  const entry = (feed.tasks ?? []).find(task => task.task_id === taskId) ?? null
  return { available: true, token: entry?.attention?.token ?? null, entry }
}

/**
 * The reply controls' attention for one task. single: attentionFor's answer, or null when GET
 * /attention failed. own: occurrenceAttention's answer from GET /occurrences ({ key, review,
 * question } for a repeating reminder's occurrence, null for a one-off task, undefined when that
 * read failed). The feed carries both kinds of task and their submission tokens; an occurrence
 * also keeps its /occurrences row, which says whether Accept and the composer apply.
 */
export function replyAttention(single, own) {
  const failed = { available: false, token: null, failed: true }
  // Couldn't tell it's a one-off (no /occurrences answer and no feed entry): retry rather than guess.
  if (own === undefined && !single?.entry) return failed
  const base = single ?? failed
  return own ? { ...base, occurrence: own } : base
}

/**
 * Whether a repeating reminder's occurrence holds back the conversation's composer: Hermes shows a
 * question or result, but the occurrence's own row isn't at that step (a pause, a check-off
 * question), so the board's occurrence footer says what to do instead. occurrence: replyAttention's
 * `occurrence`, or undefined until GET /occurrences answers.
 */
export const occurrenceHolds = (mode, occurrence) => Boolean(mode && occurrence && !(mode === 'review' ? occurrence.review : occurrence.question))

/** The source reminder snapshot id for this task from GET /delegation, for accept. */
export function sourceIdFor(delegation, taskId) {
  const task = (delegation?.tasks ?? []).find(entry => entry.task_id === taskId)
  return task?.expected?.id ?? null
}

/** Storage key for a draft: one per destination, occurrence and action. The stored draft
 *  keeps any unanswered submission (key, token and exact text) for replay. */
export function draftKey(dest, occurrence, action) {
  return ['rk-task-draft', dest.owner, dest.link, occurrence ?? 'current', action].join(':')
}

/** Where the thread's scroll position is remembered for the session (per task and occurrence). */
export function scrollKey(dest, occurrence) {
  return ['rk-task-scroll', dest.owner, dest.link, occurrence ?? 'current'].join(':')
}

/** How close to the bottom (px) still counts as reading the newest message. */
export const FOLLOW_PX = 80

/**
 * What the thread scroller does after a render (the council's spec):
 * - first fill: restore this task's position from earlier in the session, else open at the
 *   bottom (a thread that fits just shows from the top); a finished task (nothing waiting on you)
 *   opens at the top instead;
 * - after you send: always the bottom;
 * - a new message: follow it only while you're within FOLLOW_PX of the bottom, else keep your
 *   place and offer "Jump to latest" ('behind');
 * - anything else: keep.
 */
export function scrollPlan({ opened, saved, sent, grew, atBottom, finished }) {
  if (!opened) return saved != null ? 'restore' : finished ? 'top' : 'bottom'
  if (sent) return 'bottom'
  if (grew) return atBottom ? 'bottom' : 'behind'
  return 'keep'
}

/** What Send submits: an unanswered submission for this same attention token is replayed exactly
 *  (key and text), whatever the box now holds; otherwise a fresh key with the current text. */
export function nextSubmission(pending, token, text, mint) {
  if (pending?.key && pending.token === token) return pending
  return { key: mint(), token, text: text.trim() }
}

/**
 * Outcome of POST /attention/submissions or /delegation/actions accept.
 * keepDraft: the text stays for another try. reread: fetch the task again.
 * sameKey: a retry must reuse the submission key (never mint a new one).
 */
export function submissionOutcome(response, action, taskId) {
  const status = response?.status
  const reason = response?.reason
  if (action === 'accept' && status === 'ok') {
    // The envelope is ok even when this task's acceptance did not finish; read its own row.
    const task = (response.tasks ?? []).find(entry => entry.task_id === taskId)
    if (task?.status === 'done' && task.completion?.status === 'completed') return { kind: 'sent', keepDraft: false, reread: true }
    if (task?.status === 'needs_reconciliation') {
      return { kind: 'pending', keepDraft: true, reread: true, message: "Accepted in Hermes, but the reminder isn't completed yet. Hermes needs to check it." }
    }
    return { kind: 'failed', keepDraft: true, reread: true, message: "Couldn't accept yet. Try again." }
  }
  if (action !== 'accept' && status === 'submitted') {
    return { kind: 'sent', keepDraft: false, reread: true }
  }
  if (status === 'needs_reconciliation') {
    return { kind: 'pending', keepDraft: true, reread: true, sameKey: true, message: 'Sent. Hermes is checking it before the task continues.' }
  }
  if (status === 'conflict' && reason === 'attention_already_submitted') {
    return { kind: 'already', keepDraft: false, reread: true, message: 'This was already answered.' }
  }
  if (status === 'conflict') {
    return { kind: 'changed', keepDraft: true, reread: true, message: action === 'accept' ? 'The task changed. Check it, then accept again.' : 'The task changed. Your draft is kept.' }
  }
  if (status === 'attention' && reason === 'worker_still_alive') {
    return { kind: 'busy', keepDraft: true, reread: false, sameKey: true, message: 'Hermes is still finishing the last attempt. Try again in a moment.' }
  }
  if (status === 'attention' && reason === 'source_veto' && (response?.task?.wait_reason === 'source_unavailable' || response?.task?.guard?.status === 'waiting_source')) {
    return { kind: 'veto', keepDraft: true, reread: true, message: "Hermes can't read Reminders right now. Your draft is kept; send again once it's back." }
  }
  if (status === 'attention' && reason === 'source_veto') {
    return { kind: 'veto', keepDraft: true, reread: true, message: 'The reminder changed in Apple Reminders, so the task is on hold. Your draft is kept.' }
  }
  if (status === 'setup_required') {
    return { kind: 'unavailable', keepDraft: true, reread: false, sameKey: true, message: "Hermes isn't set up to take replies for this task yet." }
  }
  // #80: Accept waits while Reminders can't be read; the result stays here to accept again.
  if (status === 'waiting_source') {
    return { kind: 'failed', keepDraft: true, reread: true, message: "Hermes can't read Reminders right now. Accept again once it's back." }
  }
  if (status === 'access_denied') {
    return { kind: 'failed', keepDraft: true, reread: false, sameKey: true, message: action === 'accept' ? ACCESS.full : `${ACCESS.full} Your draft is kept.` }
  }
  // Accept sends nothing and has no draft: its own words, the ones a drag to Done uses.
  if (action === 'accept') return { kind: 'failed', keepDraft: true, reread: true, sameKey: true, message: "Couldn't accept yet. Try again." }
  return { kind: 'failed', keepDraft: true, reread: true, sameKey: true, message: "Couldn't send. Your draft is kept." }
}

/** Short relative-free time label for epoch seconds. */
export function formatWhen(seconds, format) {
  if (!seconds) return null
  return format.format(new Date(seconds * 1000))
}

/**
 * What a screen reader hears when Hermes adds to an open thread: 'Hermes asked a question',
 * 'Result ready', 'Hermes replied', or null (nothing new, or the newest words are yours).
 * before: how many items the thread had at the last look; items: threadOf's list now.
 */
export function threadArrival(before, items) {
  const added = (items ?? []).slice(before).filter(item => item.type !== 'activity')
  const last = added[added.length - 1]
  if (!last || last.type !== 'hermes') return null
  return last.kind === 'question' ? 'Hermes asked a question' : last.kind === 'result' ? 'Result ready' : 'Hermes replied'
}
