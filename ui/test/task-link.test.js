import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  attentionFor,
  occurrenceHolds,
  replyAttention,
  classifyLinkError,
  draftKey,
  inputMode,
  LINK_PROBLEMS,
  nextSubmission,
  pageEntry,
  linkParts,
  pendingReply,
  scrollKey,
  scrollPlan,
  sentReply,
  notesWithoutLink,
  pagePath,
  parseTaskLink,
  resolverPath,
  sourceIdFor,
  settledSubmission, submissionOutcome,
  taskLinkOf,
  taskView,
  threadOf
} from '../src/lib/task-link.js'

const OWNER = '307e8bbb-424c-49fb-89cf-058fe70dc685'
const LINK = '0c5d072d-e29e-4e30-ad4d-c387f7cdc113'

test('parses the page link the backend mints', () => {
  const dest = parseTaskLink(`https://owner.example/reminders?owner=${OWNER}&link=${LINK}&profile=work`)
  assert.deepEqual({ ...dest, url: undefined }, { owner: OWNER, link: LINK, profile: 'work', occurrence: null, url: undefined })
})

test('parses the older JSON resource link and defaults the profile', () => {
  const dest = parseTaskLink(`https://owner.example/api/plugins/reminders-kanban/task-links/${OWNER}/${LINK}`)
  assert.equal(dest.owner, OWNER)
  assert.equal(dest.link, LINK)
  assert.equal(dest.profile, 'default')
})

test('rejects other URLs and unsafe ids', () => {
  assert.equal(parseTaskLink('https://example.com/'), null)
  assert.equal(parseTaskLink('not a url at all ::'), null)
  assert.equal(parseTaskLink(`https://x/reminders?owner=${OWNER}`), null)
  assert.equal(parseTaskLink('https://x/reminders?owner=a%2Fb&link=c'), null)
  assert.equal(parseTaskLink(undefined), null)
})

test('finds the link in the URL field, else the last Open in Hermes line', () => {
  const url = `https://o.example/reminders?owner=${OWNER}&link=${LINK}&profile=default`
  assert.equal(taskLinkOf({ url, notes: '' }).link, LINK)
  assert.equal(taskLinkOf({ url: 'https://other.example', notes: `Buy milk\n\nOpen in Hermes: ${url}` }).owner, OWNER)
  assert.equal(taskLinkOf({ url: null, notes: 'Open in Hermes: https://nope.example/x' }), null)
  assert.equal(taskLinkOf(null), null)
})

test('hides only the task link line from notes', () => {
  assert.equal(notesWithoutLink('Buy milk\n\nOpen in Hermes: https://o.example/reminders?owner=a&link=b'), 'Buy milk')
  assert.equal(notesWithoutLink('Open in Hermes: https://o.example/reminders?owner=a&link=b'), '')
  assert.equal(notesWithoutLink('Keep this\nand this'), 'Keep this\nand this')
  assert.equal(notesWithoutLink(null), '')
  assert.equal(notesWithoutLink('Instructions: Open in Hermes: Settings > Account'), 'Instructions: Open in Hermes: Settings > Account')
  assert.equal(notesWithoutLink('Open in Hermes: Settings'), 'Open in Hermes: Settings')
})

test('builds resolver and page paths for a destination and occurrence', () => {
  const dest = { owner: OWNER, link: LINK, profile: 'default', occurrence: null }
  assert.equal(resolverPath(dest), `/task-links/${OWNER}/${LINK}?profile=default`)
  assert.equal(resolverPath(dest, 'occ-1'), `/task-links/${OWNER}/${LINK}?profile=default&occurrence=occ-1`)
  assert.equal(pagePath(dest, 'occ-1'), `/reminders?owner=${OWNER}&link=${LINK}&profile=default&occurrence=occ-1`)
})

const resolved = (overrides = {}) => ({
  status: 'resolved',
  destination: { owner_id: OWNER, link_id: LINK, occurrence_id: null },
  binding: { board: 'rk-test-08', task: 't_1', profile: 'default' },
  current_occurrence_id: 'occ-2',
  selected_occurrence_id: 'occ-2',
  historical: false,
  occurrence_ids: ['occ-1', 'occ-2'],
  state: 'question',
  actions: ['comment', 'resume'],
  question: 'Which color?',
  result: null,
  comments: [
    { id: 1, author: 'hermes', body: 'older', created_at: 10 },
    { id: 2, author: 'reminders-kanban:abc', body: 'newer', created_at: 20 }
  ],
  attempts: [
    { id: 5, outcome: 'blocked', summary: 'first', started_at: 100, session_id: 's1' },
    { id: 9, outcome: null, summary: 'second', started_at: 200, session_id: 's2' }
  ],
  transcript_mode: 'read_only',
  ...overrides
})

test('puts the current question first and history newest first', () => {
  const view = taskView(resolved())
  assert.equal(view.kind, 'resolved')
  assert.deepEqual(view.current, { kind: 'question', text: 'Which color?' })
  assert.deepEqual(view.attempts.map(a => [a.id, a.number, a.sessionId]), [[9, 2, 's2'], [5, 1, 's1']])
  assert.deepEqual(view.comments.map(c => [c.body, c.fromYou]), [['newer', true], ['older', false]])
  assert.equal(view.taskId, 't_1')
  assert.equal(inputMode(view), 'reply')
  assert.deepEqual(view.occurrences.map(o => o.current), [false, true])
})

test('marks the host approval step and names a running attempt', () => {
  const view = taskView(
    resolved({
      attempts: [
        { id: 1, outcome: 'review_requested', summary: 'Blue', started_at: 1 },
        { id: 2, outcome: 'completed', summary: 'Review approved without additional evidence.', metadata: { approval: 'manual' }, started_at: 2 },
        { id: 3, outcome: null, status: 'running', started_at: 3 }
      ]
    })
  )
  assert.deepEqual(view.attempts.map(a => [a.id, a.outcome, a.accepted]), [[3, 'running', false], [2, 'completed', true], [1, 'review_requested', false]])
})

test('shows a result for review, and a done result without input', () => {
  const review = taskView(resolved({ state: 'result', actions: ['accept', 'request_changes'], question: null, result: 'Blue' }))
  assert.deepEqual(review.current, { kind: 'result', text: 'Blue' })
  assert.equal(inputMode(review), 'review')
  const done = taskView(resolved({ state: 'done', actions: [], question: null, result: 'Blue' }))
  assert.deepEqual(done.current, { kind: 'result', text: 'Blue' })
  assert.equal(inputMode(done), null)
})

test('historical occurrences are read-only even if actions were sent', () => {
  const view = taskView(resolved({ historical: true, selected_occurrence_id: 'occ-1', actions: ['comment'] }))
  assert.deepEqual(view.actions, [])
  assert.equal(inputMode(view), null)
})

test('maps resolver failures to problem screens', () => {
  assert.equal(taskView({ status: 'sign_in_required' }).kind, 'sign_in')
  assert.equal(taskView({ status: 'wrong_owner' }).kind, 'wrong_owner')
  assert.equal(taskView({ status: 'not_found' }).kind, 'not_found')
  assert.equal(taskView({ status: 'unavailable_owner' }).kind, 'unavailable')
  assert.equal(taskView(undefined).kind, 'unavailable')
})

test('only problems a retry can fix offer Try again', () => {
  assert.equal(LINK_PROBLEMS.wrong_owner.action, null)
  assert.equal(LINK_PROBLEMS.not_found.action, null)
  assert.equal(LINK_PROBLEMS.unavailable.action, 'Try again')
})

test('maps request failures: auth, missing backend, and anything else is unavailable', () => {
  assert.equal(classifyLinkError(new Error('401: {"status":"sign_in_required"}')), 'sign_in')
  assert.equal(classifyLinkError({ statusCode: 403 }), 'sign_in')
  assert.equal(classifyLinkError(new Error('404: Not Found')), 'backend_missing')
  assert.equal(classifyLinkError(new TypeError('Failed to fetch')), 'unavailable')
  assert.equal(classifyLinkError(new Error('502: bad gateway')), 'unavailable')
  assert.equal(classifyLinkError({ name: 'SupersededError' }), 'superseded')
})

test('takes the submission token from the attention feed for this task only', () => {
  const feed = { status: 'ok', tasks: [{ task_id: 't_0', attention: { token: 'x' } }, { task_id: 't_1', attention: { token: 'k:42' } }] }
  assert.equal(attentionFor(feed, 't_1').token, 'k:42')
  assert.equal(attentionFor(feed, 't_9').token, null)
  assert.equal(attentionFor({ status: 'setup_required' }, 't_1').available, false)
  assert.equal(sourceIdFor({ tasks: [{ task_id: 't_1', expected: { id: 'src' } }] }, 't_1'), 'src')
  assert.equal(sourceIdFor({ tasks: [] }, 't_1'), null)
})

test('drafts are keyed by destination, occurrence and action', () => {
  const dest = { owner: 'o', link: 'l' }
  assert.equal(draftKey(dest, 'occ', 'reply'), 'rk-task-draft:o:l:occ:reply')
  assert.equal(draftKey(dest, null, 'reply'), 'rk-task-draft:o:l:current:reply')
})

test('an unanswered submission is replayed unchanged even after the draft is edited', () => {
  const pending = { key: 'k1', token: 't:1', text: 'Blue' }
  assert.deepEqual(nextSubmission(pending, 't:1', 'Green, actually', () => 'fresh'), pending)
  assert.deepEqual(nextSubmission(pending, 't:2', ' Green ', () => 'fresh'), { key: 'fresh', token: 't:2', text: 'Green' })
  assert.deepEqual(nextSubmission(null, 't:1', 'Blue', () => 'fresh'), { key: 'fresh', token: 't:1', text: 'Blue' })
})

test('submission outcomes keep the draft and key whenever the reply may not have landed', () => {
  assert.deepEqual(submissionOutcome({ status: 'submitted' }, 'reply'), { kind: 'sent', keepDraft: false, reread: true })
  const accepted = { status: 'ok', tasks: [{ task_id: 't_1', status: 'done', completion: { status: 'completed' } }] }
  assert.equal(submissionOutcome(accepted, 'accept', 't_1').kind, 'sent')
  const unsettled = { status: 'ok', tasks: [{ task_id: 't_1', status: 'needs_reconciliation', completion: { status: 'needs_reconciliation' } }] }
  assert.equal(submissionOutcome(unsettled, 'accept', 't_1').kind, 'pending')
  assert.equal(submissionOutcome(unsettled, 'accept', 't_1').keepDraft, true)
  assert.equal(submissionOutcome({ status: 'ok', tasks: [{ task_id: 't_1', status: 'result' }] }, 'accept', 't_1').kind, 'failed')
  assert.equal(submissionOutcome(accepted, 'accept', 't_other').kind, 'failed')
  assert.equal(submissionOutcome({ status: 'conflict', reason: 'attention_changed' }, 'reply').keepDraft, true)
  assert.equal(submissionOutcome({ status: 'conflict', reason: 'attention_already_submitted' }, 'reply').kind, 'already')
  const busy = submissionOutcome({ status: 'attention', reason: 'worker_still_alive' }, 'reply')
  assert.equal(busy.sameKey, true)
  assert.equal(busy.keepDraft, true)
  assert.equal(submissionOutcome({ status: 'needs_reconciliation' }, 'reply').sameKey, true)
  assert.equal(submissionOutcome({ status: 'attention', reason: 'source_veto' }, 'request_changes').kind, 'veto')
  // Reminders unreadable is not a change to the reminder.
  assert.match(submissionOutcome({ status: 'attention', reason: 'source_veto', task: { wait_reason: 'source_unavailable' } }, 'reply').message, /can't read Reminders/)
  assert.match(submissionOutcome({ status: 'attention', reason: 'source_veto' }, 'reply').message, /changed in Apple Reminders/)
  assert.equal(submissionOutcome(undefined, 'reply').kind, 'failed')
})

test('the conversation is oldest first, says each thing once and hides internal run text', () => {
  const view = taskView(
    resolved({
      state: 'result',
      actions: ['accept', 'request_changes'],
      question: null,
      result: 'Blue, larger title',
      comments: [
        { id: 1, author: 'reminders-kanban:k1', body: 'Blue', created_at: 30 },
        { id: 2, author: 'someone', body: 'FYI', created_at: 31 }
      ],
      attempts: [
        { id: 1, outcome: 'rate_limited', summary: null, error: 'pid 9 exited rate-limited', started_at: 10, ended_at: 12 },
        { id: 2, outcome: 'blocked', summary: 'Which color?', started_at: 20, ended_at: 25 },
        { id: 3, outcome: 'review_requested', summary: 'Blue, larger title', started_at: 40, ended_at: 45 }
      ]
    })
  )
  const thread = threadOf(view)
  assert.deepEqual(
    thread.map(item => [item.type, item.text ?? item.label]),
    [
      ['activity', 'Waited for capacity'],
      ['activity', 'Worked for 5s'],
      ['hermes', 'Which color?'],
      ['you', 'Blue'],
      ['comment', 'FYI'],
      ['activity', 'Worked for 5s'],
      ['hermes', 'Blue, larger title']
    ]
  )
  assert.equal(thread.at(-1).current, true)
  assert.equal(thread.filter(item => item.current).length, 1)
  assert.ok(!thread.some(item => /pid/.test(item.text)))
})

test('the approval step reads as You accepted and a missing current message is added once', () => {
  const view = taskView(
    resolved({
      state: 'done',
      actions: [],
      question: null,
      result: 'Final',
      comments: [],
      attempts: [
        { id: 1, outcome: 'review_requested', summary: 'Final', started_at: 1, ended_at: 2 },
        { id: 2, outcome: 'completed', summary: 'Review approved without additional evidence.', metadata: { approval: 'manual' }, started_at: 3, ended_at: 4 }
      ]
    })
  )
  assert.deepEqual(threadOf(view).map(item => [item.type, item.text ?? item.label]), [
    ['activity', 'Worked for 1s'],
    ['hermes', 'Final'],
    ['activity', 'Accepted']
  ])
  const asked = taskView(resolved({ attempts: [], comments: [] }))
  assert.deepEqual(threadOf(asked).map(item => [item.type, item.text, item.current]), [['hermes', 'Which color?', true]])
  assert.deepEqual(threadOf({ kind: 'sign_in' }), [])
})

test('replies in the same second keep the order they were sent', () => {
  const view = taskView(
    resolved({
      comments: [
        { id: 1, author: 'reminders-kanban:a', body: 'First', created_at: 50 },
        { id: 2, author: 'reminders-kanban:b', body: 'Second', created_at: 50 }
      ],
      attempts: []
    })
  )
  assert.deepEqual(threadOf(view).filter(item => item.type === 'you').map(item => item.text), ['First', 'Second'])
})

test('a sent reply shows as pending until the task holds your copy of it', () => {
  const thread = [
    { type: 'hermes', text: 'Blue or green?' },
    { type: 'you', text: 'Blue, with a white title.' }
  ]
  assert.equal(pendingReply(null, thread), null)
  assert.equal(pendingReply(sentReply('  ', thread), thread), null)
  const larger = sentReply('Make the title larger.', thread)
  assert.equal(pendingReply(larger, thread), 'Make the title larger.')
  assert.equal(pendingReply(larger, [...thread, { type: 'you', text: 'Make the title larger. ' }]), null)
  // Hermes saying the same words is not your copy.
  assert.equal(pendingReply(sentReply('Blue or green?', thread), thread), 'Blue or green?')
  // A repeated answer stays pending until its own new comment arrives.
  const again = sentReply('Blue, with a white title.', thread)
  assert.equal(pendingReply(again, thread), 'Blue, with a white title.')
  assert.equal(pendingReply(again, [...thread, { type: 'you', text: 'Blue, with a white title.' }]), null)
})

test('the browser keeps links in message text clickable', () => {
  assert.deepEqual(linkParts('No links here.'), ['No links here.'])
  assert.deepEqual(linkParts('See [the report](https://example.test/r?a=1) now.'), [
    'See ',
    { href: 'https://example.test/r?a=1', label: 'the report' },
    ' now.'
  ])
  assert.deepEqual(linkParts('Saved to https://example.test/a.png.'), [
    'Saved to ',
    { href: 'https://example.test/a.png', label: 'https://example.test/a.png' },
    '.'
  ])
  // Balanced parentheses stay in the target, in both forms.
  assert.deepEqual(linkParts('[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))'), [
    { href: 'https://en.wikipedia.org/wiki/Mercury_(planet)', label: 'Mercury' }
  ])
  assert.deepEqual(linkParts('(see https://en.wikipedia.org/wiki/Mercury_(planet)).'), [
    '(see ',
    { href: 'https://en.wikipedia.org/wiki/Mercury_(planet)', label: 'https://en.wikipedia.org/wiki/Mercury_(planet)' },
    ').'
  ])
  // Only http(s) targets become links.
  assert.deepEqual(linkParts('[x](javascript:alert(1))'), ['[x](javascript:alert(1))'])
})

test('the thread scroll follows the council spec', () => {
  // Opening: back where you were this session, else at the newest message.
  assert.equal(scrollPlan({ opened: false, saved: null }), 'bottom')
  assert.equal(scrollPlan({ opened: false, saved: 120 }), 'restore')
  assert.equal(scrollPlan({ opened: false, saved: 0 }), 'restore')
  // A finished task (nothing waiting on you) opens at the top.
  assert.equal(scrollPlan({ opened: false, saved: null, finished: true }), 'top')
  // After you send: always the bottom, even while reading further up.
  assert.equal(scrollPlan({ opened: true, sent: true, grew: true, atBottom: false }), 'bottom')
  // A new message: follow only near the bottom, else offer Jump to latest.
  assert.equal(scrollPlan({ opened: true, grew: true, atBottom: true }), 'bottom')
  assert.equal(scrollPlan({ opened: true, grew: true, atBottom: false }), 'behind')
  // A poll with nothing new leaves the view alone.
  assert.equal(scrollPlan({ opened: true, grew: false, atBottom: false }), 'keep')
  assert.equal(scrollKey({ owner: 'o', link: 'l' }, null), 'rk-task-scroll:o:l:current')
})

test('activity lines follow core chat: one line per finished run, the live run separate', async () => {
  const { formatElapsed, liveActivity, workedLabel } = await import('../src/lib/task-link.js')
  assert.equal(formatElapsed(12), '12s')
  assert.equal(formatElapsed(130), '2:10')
  assert.equal(workedLabel(0.4), 'Worked briefly')
  assert.equal(workedLabel(72), 'Worked for 1:12')
  assert.equal(workedLabel(null), 'Worked')
  const running = taskView(
    resolved({
      state: 'active',
      question: null,
      comments: [],
      attempts: [
        { id: 1, outcome: 'reclaimed', summary: null, started_at: 1, ended_at: 41 },
        { id: 2, status: 'running', outcome: null, summary: null, started_at: 100, ended_at: null }
      ]
    })
  )
  // The stopped run is one line with its duration; the running one is not a thread item.
  assert.deepEqual(threadOf(running).map(item => [item.type, item.label, item.meta]), [['activity', 'Stopped', '40s']])
  assert.deepEqual(liveActivity(running), { kind: 'working', label: 'Working', since: 100 })
  const queued = taskView(resolved({ state: 'ready', question: null, comments: [], attempts: [] }))
  assert.deepEqual(liveActivity(queued), { kind: 'queued', label: 'Waiting for a free slot', since: null })
  assert.equal(liveActivity(queued, { queuedLabel: 'Up next' }).label, 'Up next')
  // A stop the runs already show is not said twice.
  const stopped = taskView(resolved({ state: 'stopped', question: null, comments: [], attempts: [{ id: 1, outcome: 'reclaimed', started_at: 1, ended_at: 2 }] }))
  assert.equal(liveActivity(stopped), null)
  assert.equal(liveActivity(taskView(resolved({ state: 'result', question: null, result: 'R', comments: [], attempts: [] }))), null)
})

test('queued on the board wins over Hermes’ parked state; a real pause still says Paused', async () => {
  const { liveActivity } = await import('../src/lib/task-link.js')
  const parked = taskView(resolved({ state: 'paused', question: null, comments: [], attempts: [] }))
  assert.deepEqual(liveActivity(parked, { queued: true, queuedLabel: 'Waiting for a free slot' }), { kind: 'queued', label: 'Waiting for a free slot', since: null })
  assert.deepEqual(liveActivity(parked), { kind: 'paused', label: 'Paused', since: null })
})

test('what Hermes did before a stop shows above the Stopped line', () => {
  const view = taskView(
    resolved({
      state: 'stopped',
      question: null,
      binding: { board: 'b', task: 't_1', profile: 'default' },
      comments: [
        { id: 1, author: 'default', body: 'Found three sources.', created_at: 12 },
        { id: 2, author: 'someone', body: 'FYI', created_at: 13 }
      ],
      attempts: [{ id: 1, outcome: 'reclaimed', summary: 'Outline half done.', started_at: 10, ended_at: 40 }]
    })
  )
  assert.deepEqual(threadOf(view).map(item => [item.type, item.text ?? item.label]), [
    ['hermes', 'Found three sources.'],
    ['comment', 'FYI'],
    // The host's text for a stopped run ("task archived with run still active") is not Hermes speaking.
    ['activity', 'Stopped']
  ])
})

test('history across attempts: change requests and earlier results are named', () => {
  const view = taskView(
    resolved({
      state: 'result',
      actions: ['accept', 'request_changes'],
      question: null,
      result: 'Blue, title larger',
      comments: [
        { id: 1, author: 'reminders-kanban:a', body: 'Blue', created_at: 15 },
        { id: 2, author: 'reminders-kanban:b', body: 'Larger title', created_at: 25 }
      ],
      attempts: [
        { id: 1, outcome: 'blocked', summary: 'Which color?', started_at: 10, ended_at: 11 },
        { id: 2, outcome: 'review_requested', summary: 'Blue', started_at: 16, ended_at: 20 },
        { id: 3, outcome: 'review_requested', summary: 'Blue, title larger', started_at: 26, ended_at: 30 }
      ]
    })
  )
  assert.deepEqual(
    threadOf(view)
      .filter(item => item.type !== 'activity')
      .map(item => [item.type, item.text, item.asks ?? item.round ?? null]),
    [
      ['hermes', 'Which color?', null],
      ['you', 'Blue', null],
      ['hermes', 'Blue', 'earlier'],
      ['you', 'Larger title', 'changes'],
      ['hermes', 'Blue, title larger', 'latest']
    ]
  )
  // One result: no round labels.
  const once = taskView(resolved({ state: 'result', actions: ['accept'], question: null, result: 'Blue', comments: [], attempts: [{ id: 1, outcome: 'review_requested', summary: 'Blue', started_at: 1, ended_at: 2 }] }))
  assert.equal(threadOf(once).find(item => item.type === 'hermes').round, undefined)
})

// Ticket 35: a repeating reminder's occurrence answers and asks for changes with the feed's token.
test('an occurrence gets the feed token and keeps its /occurrences row', () => {
  const feed = { status: 'ok', tasks: [{ task_id: 't_1', attention: { token: 'K:42' } }] }
  const own = { key: 'K', review: false, question: true }
  const merged = replyAttention(attentionFor(feed, 't_1'), own)
  assert.equal(merged.available, true)
  assert.equal(merged.token, 'K:42')
  assert.deepEqual(merged.occurrence, own)
  // A one-off task: the feed alone.
  assert.equal(replyAttention(attentionFor(feed, 't_1'), null).occurrence, undefined)
  // The feed failed: an occurrence still knows it is one, with no token to send.
  assert.deepEqual(replyAttention(null, own), { available: false, token: null, failed: true, occurrence: own })
  // Neither read can tell what the task is: retry.
  assert.deepEqual(replyAttention(attentionFor({ status: 'ok', tasks: [] }, 't_1'), undefined), { available: false, token: null, failed: true })
  assert.equal(replyAttention(attentionFor(feed, 't_1'), undefined).token, 'K:42')
})

test('an occurrence whose own row is not at that question or review holds the composer back', () => {
  assert.equal(occurrenceHolds('reply', { question: true, review: false }), false)
  assert.equal(occurrenceHolds('review', { question: false, review: true }), false)
  // Paused for a change in Reminders, or asking whether it was checked off: the board footer answers.
  assert.equal(occurrenceHolds('review', { question: false, review: false }), true)
  assert.equal(occurrenceHolds('reply', { question: false, review: false }), true)
  // One-off tasks, or before GET /occurrences answers: the composer as usual.
  assert.equal(occurrenceHolds('reply', undefined), false)
  assert.equal(occurrenceHolds(null, { question: false }), false)
})

test('a recovery receipt reads as an activity line, never as your message', () => {
  const view = taskView(
    resolved({
      state: 'failed',
      question: null,
      comments: [
        { id: 3, author: 'reminders-kanban:recovery-7', body: 'Verified previous attempt effects; do not repeat completed writes', created_at: 30 },
        { id: 4, author: 'reminders-kanban:abc', body: 'my reply', created_at: 40 }
      ]
    })
  )
  const thread = threadOf(view)
  const receipt = thread.find(item => item.at === 30)
  assert.equal(receipt.type, 'activity')
  assert.doesNotMatch(receipt.label, /Verified/)
  assert.equal(thread.find(item => item.at === 40).type, 'you')
})

// Ticket 28 (found by lane D): the bare browser page names no task, so it is not "not found".
test('pageEntry: the bare page is an empty state, a named but unreadable task is not found', () => {
  assert.deepEqual(pageEntry('https://owner.example/reminders'), { kind: 'no_task' })
  assert.deepEqual(pageEntry('https://owner.example/reminders/'), { kind: 'no_task' })
  assert.deepEqual(pageEntry('https://owner.example/proxy/reminders?profile=work'), { kind: 'no_task' })
  assert.equal(pageEntry(`https://owner.example/reminders?owner=${OWNER}`).kind, 'not_found')
  assert.equal(pageEntry(`https://owner.example/reminders?owner=${OWNER}&link=bad%20link`).kind, 'not_found')
  assert.equal(pageEntry('https://owner.example/api/plugins/reminders-kanban/task-links/%ZZ/x').kind, 'not_found')
  const task = pageEntry(`https://owner.example/reminders?owner=${OWNER}&link=${LINK}&profile=work`)
  assert.equal(task.kind, 'task')
  assert.equal(task.dest.link, LINK)
})

test('bindingDest and cardDest: the written link first, else the stored binding, never a copied one', async () => {
  const { bindingDest, cardBinding, cardDest } = await import('../src/lib/task-link.js')
  const binding = { owner_id: OWNER, link_id: 'lnk_1', url: null }
  assert.deepEqual(bindingDest(binding, 'work'), { owner: OWNER, link: 'lnk_1', profile: 'work', occurrence: null, url: null })
  assert.equal(bindingDest({ owner_id: OWNER }, 'default'), null)
  assert.equal(bindingDest({ owner_id: '../x', link_id: 'lnk_1' }, 'default'), null)
  assert.equal(bindingDest(null, 'default'), null)
  const withUrl = bindingDest({ ...binding, url: ' https://mac.example/reminders?owner=o&link=l ' }, 'default')
  assert.equal(withUrl.url, 'https://mac.example/reminders?owner=o&link=l')

  // One-off: the delegation row's binding.
  const oneOff = { source: { id: 'r1', notes: 'Do it' }, agent: { row: { destination: binding } } }
  assert.equal(cardBinding(oneOff), binding)
  assert.equal(cardDest(oneOff, 'default').link, 'lnk_1')
  // Repeating: the occurrence's binding (a successor card has no agent row).
  const successor = { source: { id: 'r2', notes: '' }, occurrence: { role: 'successor', destination: binding } }
  assert.equal(cardDest(successor, 'default').owner, OWNER)
  // A copied link is never this card's task.
  assert.equal(cardBinding({ ...oneOff, linkCopy: { taskId: 't' } }), null)
  // A written link wins over the binding.
  const link = `https://mac.example/reminders?owner=${OWNER}&link=lnk_written&profile=default`
  assert.equal(cardDest({ ...oneOff, source: { id: 'r1', notes: `Do it\n\nOpen in Hermes: ${link}` } }, 'default').link, 'lnk_written')
  assert.equal(cardDest({ source: { id: 'r3', notes: '' } }, 'default'), null)
})

test('a reply Hermes settled by itself is not offered again for the next question', () => {
  const kept = { key: 'k', token: 'old', text: 'Use the blue one' }
  const thread = [{ type: 'you', text: 'Use the blue one' }]
  assert.equal(settledSubmission(kept, 'old', 'Use the blue one', thread), null)
  assert.equal(settledSubmission(kept, null, 'Use the blue one', thread), null)
  assert.deepEqual(settledSubmission(kept, 'new', 'Use the blue one', thread), { clear: true })
  // Never reached the task, or the text was edited since: the draft stays.
  assert.deepEqual(settledSubmission(kept, 'new', 'Use the blue one', []), { clear: false })
  assert.deepEqual(settledSubmission(kept, 'new', 'Use the green one', thread), { clear: false })
})

test('an earlier identical reply does not count as the lost one having landed', () => {
  const kept = { key: 'k', token: 'old', text: 'Yes', seen: 1 }
  assert.deepEqual(settledSubmission(kept, 'new', 'Yes', [{ type: 'you', text: 'Yes' }]), { clear: false })
  assert.deepEqual(settledSubmission(kept, 'new', 'Yes', [{ type: 'you', text: 'Yes' }, { type: 'you', text: 'Yes' }]), { clear: true })
})

test('a screen reader hears when Hermes adds to an open thread, never your own words', async () => {
  const { threadArrival } = await import('../src/lib/task-link.js')
  const you = { type: 'you', text: 'go' }
  const did = { type: 'activity', label: 'Thought for 3s' }
  assert.equal(threadArrival(1, [you]), null)
  assert.equal(threadArrival(1, [you, did]), null)
  assert.equal(threadArrival(1, [you, did, { type: 'hermes', kind: 'question', text: 'Which?' }]), 'Hermes asked a question')
  assert.equal(threadArrival(1, [you, { type: 'hermes', kind: 'result', text: 'Done' }, did]), 'Result ready')
  assert.equal(threadArrival(0, [{ type: 'hermes', kind: 'note', text: 'fyi' }]), 'Hermes replied')
  assert.equal(threadArrival(0, [{ type: 'hermes', kind: 'result', text: 'Done' }, you]), null)
})

test('a failed Accept never talks about sending or drafts; a locked Mac is not "access off"', async () => {
  const { submissionOutcome, attentionFor } = await import('../src/lib/task-link.js')
  assert.equal(submissionOutcome({ status: 'attention', reason: 'x' }, 'accept', 't1').message, "Couldn't accept yet. Try again.")
  assert.doesNotMatch(submissionOutcome({ status: 'conflict' }, 'accept', 't1').message, /draft/)
  assert.match(submissionOutcome({ status: 'conflict' }, 'comment', 't1').message, /draft is kept/)
  const denied = submissionOutcome({ status: 'access_denied' }, 'accept', 't1').message
  assert.match(denied, /Unlock the Mac running Hermes/)
  assert.doesNotMatch(denied, /draft|access is off/)
  // Only setup_required means replies aren't set up; anything else is a read that failed.
  assert.equal(attentionFor({ status: 'attention', reason: 'x' }, 't1').failed, true)
  assert.equal(attentionFor({ status: 'setup_required' }, 't1').failed, false)
  assert.equal(attentionFor(null, 't1').failed, false)
})
