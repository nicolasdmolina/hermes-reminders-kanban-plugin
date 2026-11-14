// State for human reminder actions on one connection and profile: optimistic
// moves drawn over the server board, rollback with a reason, replay of saves whose
// outcome is unknown, and which form is open. Contract: api/human-contract.md.
import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { queryKey } from '../api/client.js'
import { postHumanAction } from '../api/human.js'
import { splitTitle } from '../lib/cards.js'
import { describeOutcome, replaySettlement } from '../lib/drafts.js'
import { applyMoves, moveVerdict, stepTarget } from '../lib/moves.js'
import { classifyError } from '../lib/state.js'
import { createRequests } from './command.js'
import { cardElement, createMotion, snapBack } from './motion.js'
import { useCardDrag } from './useCardDrag.js'
import { clearStored, useStoredDraft, writeStored } from './useStoredDraft.js'

// The backend settles once the writer has been seen gone for its grace period (Human.grace, 20 s):
// the first check notes it gone, a later one settles, so about 36 s in all.
const RECHECK_MS = 12_000

const { useQueryClient, useValue } = sdk

export const newOperationId = () =>
  typeof sdk.randomUuid === 'function' ? sdk.randomUuid() : globalThis.crypto.randomUUID()

const NOTICE_MS = 6000
// The notice actions CardNotice draws a button for.
const STICKY_ACTIONS = new Set(['privacy', 'details', 'reminders'])
// How often, and how many times, the board is re-read for a created card a read came back without.
const FRESH_RETRY_MS = 1500
const FRESH_TRIES = 4
// A confirmed move counts as saving until the board re-reads it, or this long at most.
const PENDING_READ_MS = 15_000
let consumedRequests = 0
const titleOf = card => splitTitle(card?.source?.title).text

/** Sends one action. Resolves to { result, shown } and never throws for workflow outcomes. */
export async function sendAction(scope, body) {
  try {
    const result = await postHumanAction(scope, body)
    return { result, shown: describeOutcome(result) }
  } catch (error) {
    const kind = classifyError(error)
    if (kind.kind === 'superseded') return { result: null, shown: null, superseded: true }
    return { result: null, shown: describeOutcome(null, kind) }
  }
}

/** agent (ticket 13, optional): { pickup, act(action, card), askRerun(card) } from the board page.
 *  With it, drags into Ready for Agent delegate, a result dropped on Done is accepted, and a stopped
 *  task Hermes had started opens its dialog asking Run again instead of moving. */
export function useEditor({ scope, cards, updatedAt, agent = null }) {
  const client = useQueryClient()
  const refreshBoard = () => client.invalidateQueries({ queryKey: queryKey(scope, 'preview') })

  // card id → column, for moves in flight or confirmed but not yet re-read.
  const [overlay, setOverlay] = useState({})
  const [pending, setPending] = useState({})
  const [notices, setNotices] = useState({})
  // A save whose outcome is unknown: { body, title, cardId?, draftKey?, outcome, checking }.
  // The backend blocks further writes until it resolves. Kept per scope, outside any view,
  // so a closed form or a remounted page still replays the exact same request.
  const unsureKey = `${scope.join('\u0000')}|unsure`
  const [unsure, setUnsureValue] = useStoredDraft(unsureKey)
  const setUnsure = value => setUnsureValue(value ?? undefined)
  const [announcement, setAnnouncement] = useState('')
  const [form, setForm] = useState(null)
  const [created, setCreated] = useState(null)
  const confirmed = useRef({})
  const motion = useMemo(() => createMotion(), [])
  const timers = useRef({})

  // Cards the create form just made, shown at once from the save's own answer. Reminders can take a
  // moment to hand a new reminder to the next read, so each stays until a board read includes it.
  const [fresh, setFresh] = useState({})
  const shown = useMemo(() => {
    const have = new Set((cards ?? []).map(card => card.id))
    const added = Object.values(fresh).filter(entry => !have.has(entry.card.id)).map(entry => entry.card)
    return applyMoves(added.length ? [...(cards ?? []), ...added] : cards, overlay)
  }, [cards, overlay, fresh])
  // A read that came back without a just-created card is asked again, a few times, then let go.
  useEffect(() => {
    const have = new Set((cards ?? []).map(card => card.id))
    const missing = Object.values(fresh).filter(entry => !have.has(entry.card.id))
    if (missing.length !== Object.keys(fresh).length) setFresh(Object.fromEntries(missing.map(entry => [entry.card.id, entry])))
    const waiting = missing.filter(entry => updatedAt > entry.at)
    if (!waiting.length) return
    const timer = setTimeout(() => {
      setFresh(current => {
        const next = {}
        // Only the cards this read came back without use up a try; a newer one keeps all of its own.
        for (const [id, entry] of Object.entries(current)) {
          if (updatedAt <= entry.at) next[id] = entry
          else if (entry.tries < FRESH_TRIES) next[id] = { ...entry, tries: entry.tries + 1, at: Date.now() }
        }
        return next
      })
      void refreshBoard()
    }, FRESH_RETRY_MS)
    return () => clearTimeout(timer)
  }, [cards, updatedAt, fresh]) // eslint-disable-line react-hooks/exhaustive-deps
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const byId = useMemo(() => new Map(shown.map(card => [card.id, card])), [shown])

  // A board read that started after a move was confirmed is the truth; drop its overlay.
  useEffect(() => {
    const done = Object.entries(confirmed.current).filter(([, at]) => updatedAt > at)
    if (!done.length) return
    for (const [id] of done) {
      delete confirmed.current[id]
      // The read may place it elsewhere (a recurring card returns to To do): travel there.
      const server = cards?.find(card => card.id === id)?.column
      if (server && overlayRef.current[id] && server !== overlayRef.current[id]) {
        motion.keepFocus(id)
        motion.travel(id)
      }
    }
    setOverlay(current => {
      const next = { ...current }
      for (const [id] of done) delete next[id]
      return next
    })
    setPending(current => {
      const next = { ...current }
      for (const [id] of done) {
        clearTimeout(timers.current[`pending:${id}`])
        delete next[id]
      }
      return next
    })
  }, [updatedAt, motion, cards])

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), [])

  // The palette's "New reminder" opens the create form once per request.
  // A request made before this page mounted still counts.
  const requested = useValue(createRequests)
  useEffect(() => {
    if (requested <= consumedRequests) return
    consumedRequests = requested
    setForm({ mode: 'create', storeKey: `${scope.join('\u0000')}|create` })
  }, [requested, scope])

  const announce = text => setAnnouncement(current => (current === text ? `${text} ` : text))

  const showNotice = (id, notice) => {
    clearTimeout(timers.current[id])
    setNotices(current => ({ ...current, [id]: { ...notice, key: Date.now() } }))
    // A notice with a button (STICKY_ACTIONS) stays until it is used, dismissed, or the card changes.
    if (!notice.sticky && !STICKY_ACTIONS.has(notice.action)) {
      timers.current[id] = setTimeout(() => {
        setNotices(current => {
          const next = { ...current }
          delete next[id]
          return next
        })
      }, NOTICE_MS)
    }
  }
  const dismissNotice = id => {
    clearTimeout(timers.current[id])
    setNotices(current => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  // A notice describes the card as it was. Once a board read shows the card somewhere else, or
  // completed or reopened, the reason no longer applies: drop it.
  const seen = useRef({})
  useEffect(() => {
    const next = {}
    for (const card of cards ?? []) next[card.id] = `${card.column}|${Boolean(card.source?.completed)}`
    const changed = Object.keys(notices).filter(id => seen.current[id] && next[id] && seen.current[id] !== next[id])
    seen.current = next
    // A notice raised by a save that itself rereads the board (a conflict) explains where the card
    // went, so it sits through that one change; the next change clears it like any other.
    const held = changed.filter(id => notices[id].holdOneRead)
    if (held.length) setNotices(current => Object.fromEntries(Object.entries(current).map(([id, notice]) => [id, held.includes(id) ? { ...notice, holdOneRead: false } : notice])))
    changed.filter(id => !notices[id].holdOneRead).forEach(dismissNotice)
  }, [cards]) // eslint-disable-line react-hooks/exhaustive-deps

  const refuse = (card, verdict) => {
    // An unconfirmed save blocks every move: say that, by drag as by keyboard, not "still saving".
    if (unsure && verdict.refused === 'pending') {
      showNotice(card.id, { short: 'Check the last save first', tone: 'warn' })
      announce(`${titleOf(card)} stays in ${card.column}. Check the last save first.`)
      return
    }
    showNotice(card.id, { short: verdict.reason, tone: 'warn', action: verdict.refused === 'reopen' || verdict.refused === 'labelled' ? 'reminders' : null })
    announce(`${titleOf(card)} stays in ${card.column}. ${verdict.reason}.`)
  }

  const settle = (card, to, answer, body) => {
    // A dropped answer (profile switch) may still have saved: treat it as unknown.
    const { result, shown: outcome } = answer.superseded ? { result: null, shown: describeOutcome({ status: 'uncertain' }) } : answer
    const unpend = () =>
      setPending(current => {
        if (!current[card.id]) return current
        const next = { ...current }
        delete next[card.id]
        return next
      })
    if (result?.status === 'ok') {
      // Still saving until the board re-reads it: the next move needs the new source and
      // capabilities (a just-completed card can only be reopened once the read says so).
      confirmed.current[card.id] = Date.now()
      // A card still shown from its create answer takes the move with it, so a read that comes
      // back without it doesn't put it back where it was made.
      setFresh(current =>
        current[card.id]
          ? { ...current, [card.id]: { ...current[card.id], card: { ...current[card.id].card, column: to, source: result.current ?? current[card.id].card.source } } }
          : current
      )
      clearTimeout(timers.current[`pending:${card.id}`])
      timers.current[`pending:${card.id}`] = setTimeout(unpend, PENDING_READ_MS)
      void refreshBoard()
      announce(to === 'Done' ? `${titleOf(card)} is done.` : `${titleOf(card)} moved to ${to}.`)
      return
    }
    unpend()
    // Roll back: the card travels home, keeps keyboard focus, and says why. `before` is presentation only.
    motion.keepFocus(card.id)
    motion.travel(card.id)
    setOverlay(current => {
      const next = { ...current }
      delete next[card.id]
      return next
    })
    showNotice(card.id, { short: outcome.short, tone: outcome.tone, action: outcome.action, sticky: outcome.replay, holdOneRead: result?.status === 'conflict' || result?.status === 'not_found' })
    announce(`Couldn't move ${titleOf(card)} to ${to}. ${outcome.message}`)
    if (outcome.replay) setUnsure({ body, outcome, cardId: card.id, title: titleOf(card) })
    if (result?.status === 'conflict' || result?.status === 'not_found') void refreshBoard()
  }

  /** Moves a card to `to`. `ghost` is a drag ghost to land in the new slot. */
  const verdictFor = (card, to) => {
    const verdict = moveVerdict(card, to, { pending: Boolean(pending[card.id] || unsure), pickup: agent ? agent.pickup : undefined, choose: Boolean(agent?.choose) })
    // An unconfirmed save blocks every move: the lane, the card and the announcement all say that.
    return unsure && verdict?.refused === 'pending' ? { ...verdict, reason: 'Check the last save first' } : verdict
  }

  /** verdict: a move already chosen elsewhere (ticket 21's occurrence menu), instead of the drop rules. */
  const move = async (card, to, { ghost = null, focus = false, verdict: chosen = null } = {}) => {
    const verdict = chosen ?? verdictFor(card, to)
    if (!verdict) return
    if (verdict.kind === 'choose') {
      // A repeating reminder: ask which occurrence goes to Hermes (ticket 21) instead of moving it.
      ghost?.remove()
      return agent.choose(card)
    }
    if (verdict.refused) {
      ghost?.remove()
      return refuse(card, verdict)
    }
    if (verdict.action === 'confirm') {
      // Hermes had started this stopped task: the card stays put and its dialog asks first.
      if (ghost) await snapBack(ghost, cardElement(card.id))
      agent?.askRerun?.(card)
      return
    }
    dismissNotice(card.id)
    const body = { operation_id: newOperationId(), action: verdict.action, expected: card.source, fields: verdict.fields }
    if (ghost) motion.land(card.id, ghost)
    else motion.travel(card.id)
    if (focus) motion.focus(card.id)
    setOverlay(current => ({ ...current, [card.id]: to }))
    setPending(current => ({ ...current, [card.id]: true }))
    announce(`Moving ${titleOf(card)} to ${to}…`)
    if (verdict.kind === 'delegation') {
      // Delegation actions are safe to repeat, so they never take the unknown-save path.
      const answer = await agent.act(verdict.action, card)
      if (answer.superseded) return settle(card, to, { result: { status: 'superseded' }, shown: { tone: 'warn', short: 'Switched Hermes', message: 'Switched Hermes before it finished.' } }, body)
      return settle(card, to, answer, body)
    }
    settle(card, to, await sendAction(scope, body), body)
  }

  /** Replays the unknown save with its own operation ID and body, never a new write, and
   *  settles everything that waited on it: this bar, the card, and the form's draft. */
  const replay = async () => {
    if (!unsure || unsure.checking) return
    const { body, cardId, draftKey, title } = unsure
    writeStored(unsureKey, current => current && { ...current, checking: true })
    const answer = await sendAction(scope, body)
    if (answer.superseded) return writeStored(unsureKey, current => current && { ...current, checking: false })
    const next = replaySettlement(unsure, answer.result?.status, answer.shown)
    // A second answer that still isn't sure: the bar stops promising that checking again will do it.
    writeStored(unsureKey, next.unsure ? { ...next.unsure, tries: (unsure.tries ?? 0) + 1, reached: Boolean(unsure.reached || unsure.outcome?.status === 'uncertain') } : undefined)
    if (next.draft) writeStored(draftKey, current => current && { ...current, ...next.draft })
    if (next.clearDraft) {
      clearStored(draftKey)
      setForm(current => (current?.storeKey === draftKey ? null : current))
    }
    if (next.unsure) return
    if (next.notice) {
      showNotice(cardId, { short: next.notice.short, tone: next.notice.tone, action: next.notice.action })
      announce(`${title}: ${next.notice.message ?? next.notice.short}`)
    } else if (cardId) dismissNotice(cardId)
    if (answer.result?.status === 'ok') announce(`${title} saved.`)
    else if (draftKey) {
      // A form's save that turned out not saved must not end silently: say so, and bring its form
      // (with the kept draft and the reason) back if it was closed.
      announce(`${title} wasn't saved. ${answer.shown?.message ?? ''}`)
      const tail = draftKey.slice(`${scope.join('\u0000')}|`.length)
      const back = tail === 'create' ? { mode: 'create' } : tail === 'labels' ? { mode: 'labels' } : tail.startsWith('edit|') ? { mode: 'edit', cardId: tail.slice(5) } : null
      if (back) setForm(current => current ?? { ...back, storeKey: draftKey })
    }
    void refreshBoard()
  }

  // An unsure save settles once the Reminders writer has stopped (human-contract.md): check again
  // without being asked, so the pause lifts by itself.
  const replayRef = useRef(replay)
  replayRef.current = replay
  // Only a save the backend holds as unsure. One that never reached Hermes waits for a press:
  // sending it later, unasked, could duplicate what the user did by hand meanwhile.
  const waiting = Boolean(unsure && !unsure.checking && (unsure.outcome?.status === 'uncertain' || (unsure.reached && unsure.outcome?.replay)))
  const waitedTries = unsure?.tries ?? 0
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setTimeout(() => void replayRef.current(), RECHECK_MS)
    return () => clearTimeout(timer)
  }, [waiting, waitedTries])

  const drag = useCardDrag({
    verdictFor,
    onDrop: (card, column, ghost) => void move(card, column, { ghost }),
    onRefuse: refuse
  })

  const keyMove = (cardId, direction) => {
    const card = byId.get(cardId)
    if (!card) return
    // A result steps right into Done (accept), the keyboard twin of dropping it there.
    const to = card.agent?.status === 'result' && direction > 0 ? 'Done' : stepTarget(card, direction)
    if (!to) {
      announce(`${titleOf(card)} is already in ${card.column}.`)
      return
    }
    motion.focus(card.id)
    void move(card, to, { focus: true })
  }

  return {
    scope,
    cards: shown,
    pending,
    notices,
    dismissNotice,
    unsure,
    replay,
    announcement,
    announce,
    form,
    openCreate: () => setForm({ mode: 'create', storeKey: `${scope.join('\u0000')}|create` }),
    openEdit: (cardId, anchorTop) => setForm({ mode: 'edit', cardId, anchorTop, storeKey: `${scope.join('\u0000')}|edit|${cardId}` }),
    openLabels: () => setForm({ mode: 'labels', storeKey: `${scope.join('\u0000')}|labels` }),
    closeForm: () => setForm(null),
    closeFormFor: key => setForm(current => (current?.storeKey === key ? null : current)),
    refreshBoard,
    // A saved edit's own answer goes onto the board at once, so a move made before the next read
    // sends the reminder as it now is (not the one from before the edit, which would be refused as
    // changed in Reminders). Only the source: column, owner and capabilities stay the board's.
    /** Saved labels show at once (the form reopened before the board reread would offer the old ones as a draft). */
    patchLabels: labels => client.setQueryData(queryKey(scope, 'preview'), envelope => (envelope && labels ? { ...envelope, title_labels: labels } : envelope)),
    patchSource: card =>
      client.setQueryData(queryKey(scope, 'preview'), envelope =>
        envelope?.cards && card?.source ? { ...envelope, cards: envelope.cards.map(entry => (entry.id === card.id ? { ...entry, source: card.source } : entry)) } : envelope
      ),
    focusCard: id => motion.focus(id),
    created,
    markCreated: card => {
      const id = card.id
      // The save's answer is the plain card; a reminder you just made can be started or completed
      // right away, before the board read brings its own capabilities.
      const ready = { ...card, capabilities: card.capabilities ?? { progress: true, complete: true, edit: true } }
      if (card.source) setFresh(current => ({ ...current, [id]: { card: ready, at: Date.now(), tries: 0 } }))
      setCreated(id)
      clearTimeout(timers.current.created)
      timers.current.created = setTimeout(() => setCreated(null), 1500)
    },
    motion,
    drag,
    move,
    keyMove,
    verdictFor,
    setUnsure
  }
}
