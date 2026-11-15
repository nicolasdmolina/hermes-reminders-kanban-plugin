// The /reminders-kanban page: picks setup, board, or a recovery screen from
// the backend state (lib/state.js) and owns page-level UI state.
import { Button, Codicon, Tip } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useBoardData } from '../api/board-data.js'
import { openPrivacySettings } from '../api/client.js'
import { Board } from '../board/Board.jsx'
import { AgentActions, DelegateAction, ElsewhereActions, TheirTaskAction } from '../delegation/Agent.jsx'
import { PickupControl, PickupReview } from '../delegation/Pickup.jsx'
import { useDelegation } from '../delegation/useDelegation.js'
import { EditorCardActions, EditorHeaderActions, EditorLayer } from '../editor/Editor.jsx'
import { useEditor } from '../editor/useEditor.js'
import { selectedListNames, setTitleLabels, splitTitle } from '../lib/cards.js'
import { BOARD_FOCUS, focusLeftBehind, refocus } from '../lib/focus.js'
import { keepAgentOrder } from '../lib/placement.js'
import { holdQueued, isStale, QUEUED_CHECKING, QUEUED_PICKUP_OFF, QUEUED_STALE, listsWithWork, startableReady } from '../lib/reconciliation.js'
import { deriveView, NOTICES, PROBLEMS } from '../lib/state.js'
import { Setup } from '../onboarding/Setup.jsx'
import { needsYouKey } from '../lib/attention.js'
import { AttentionChip, LooseTaskDialog, useTaskOpener } from '../questions/Attention.jsx'
import { refreshAttention, setVisibleTask } from '../questions/feed.js'
import { ReconnectNotice } from '../reconcile/Reconnect.jsx'
import { useReconnect } from '../reconcile/useReconnect.js'
import { DelegateChoice, OccurrenceActions } from '../recurring/Occurrence.jsx'
import { useRecurring } from '../recurring/useRecurring.js'
import { defineStyles } from '../styles.js'
import { TaskDialog } from '../task/TaskDialog.jsx'
import { useBoardView } from '../views/useBoardView.js'
import { ViewControl, ViewNotice } from '../views/ViewControl.jsx'
import css from './page.css'

defineStyles(css)

// The time alone for today; with its day otherwise, so yesterday's read doesn't pass for today's.
const timeOf = iso => {
  if (!iso) return null
  const date = new Date(iso)
  const today = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(undefined, { ...(today ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit' }).format(date)
}

export function BoardPage() {
  const data = useBoardData()
  // Everything below is scoped to one connection and profile; switching remounts it.
  return <BoardScreen data={data} key={data.scope.join('\u0000')} />
}

function BoardScreen({ data }) {
  const [reviewing, setReviewing] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [listDraft, setListDraft] = useState(null)
  const [openId, setOpenId] = useState(null)
  // A stopped task Hermes had started, dragged to Ready: its dialog opens asking Run again.
  const [askRerunId, setAskRerunId] = useState(null)
  // A first-run save that fails keeps the picker (and its draft) up, and still ends on Review.
  const [firstRunSave, setFirstRunSave] = useState(false)

  const derived = deriveView({ ...data, reviewing, choosing })
  const view = firstRunSave && derived.step === 'lists' ? { ...derived, revising: false } : derived
  const envelope = view.envelope
  // Titles drop the board's own labels, not only the default ones, everywhere below.
  setTitleLabels(envelope?.title_labels)
  // Occurrences still out (from useRecurring, which reads after useDelegation): with pickup off the
  // live task states still have to come in for them.
  const [occurrencesOut, setOccurrencesOut] = useState(false)
  const delegation = useDelegation(data.scope, data.previewUpdatedAt, { watching: occurrencesOut })
  // Repeating reminders' occurrences (ticket 21): their own read and tick, routed through one agent door.
  const recurring = useRecurring(data.scope, delegation, { onChoose: setOpenId })
  useEffect(() => setOccurrencesOut(Boolean(recurring.watching)), [recurring.watching])
  // Ticket 25: while Reminders can't be read the board says so; once it can, the owner rereads every
  // delegated reminder before anything is shown as safely queued again.
  const stale = view.screen === 'board' && isStale(view.notice)
  const delegatedRows = useMemo(() => [...(delegation.rows?.tasks ?? []), ...(recurring.data?.tasks ?? [])], [delegation.rows, recurring.data])
  const reconnect = useReconnect(data.scope, stale, delegatedRows, {
    ticking: delegation.pickup === true,
    oneOffTick: delegation.tickedAt,
    recurringTick: recurring.tickedAt,
    recurringQueued: (recurring.data?.tasks ?? []).some(row => row.status === 'ready')
  })
  const pickupOff = delegation.data?.status === 'ok' && delegation.data.pickup_enabled === false
  const queuedHold = stale ? QUEUED_STALE : reconnect.checking ? QUEUED_CHECKING : pickupOff ? QUEUED_PICKUP_OFF : null
  // A task whose reminder is gone (deleted, found by the reconnect check) opens through its link.
  const [loose, setLoose] = useState(null)
  // The open task's own link, so a reminder deleted while its dialog is open keeps its conversation.
  const lastOpen = useRef(null)
  // A setup or problem screen swaps out whole, taking the pressed button with it. Back on the
  // board, focus lands on the lists button (or the first card) instead of falling to the page.
  const lastScreen = useRef('board')
  useEffect(() => {
    const from = lastScreen.current
    // The first read shows the setup screen while it checks: that is loading, not a screen left.
    if (view.checking) return
    lastScreen.current = view.screen
    if (view.screen !== 'board' || from === 'board') return
    refocus(document, ['.rk-lists-trigger', '.rk-card'])
  }, [view.screen, view.checking])
  // Refresh and Check again are disabled while Reminders answers, and Check again goes with its
  // notice when access is back: either way focus would fall to the page. Once the answer is in,
  // it goes back to the pressed button, or to what replaced it.
  const refocusAfter = useRef(null)
  const refreshFrom = event => {
    refocusAfter.current = { from: event?.currentTarget ?? null, until: 0 }
    return data.refresh()
  }
  useEffect(() => {
    const pending = refocusAfter.current
    if (!pending) return
    if (data.previewPending) return void (pending.until = 0)
    pending.until ||= Date.now() + 3000
    if (view.screen !== 'board' || Date.now() > pending.until) return void (refocusAfter.current = null)
    refocus(document, pending.from?.isConnected ? [pending.from, ...BOARD_FOCUS] : BOARD_FOCUS)
  })
  // Delegated work sits where its Hermes task is (lib/placement.js), not where its title puts it.
  const placed = useMemo(
    () => holdQueued(recurring.place(envelope?.cards, delegation.live), queuedHold),
    [envelope?.cards, recurring.place, delegation.live, queuedHold]
  )
  const askRerun = card => {
    setAskRerunId(card.id)
    setOpenId(card.id)
  }
  const editor = useEditor({ scope: data.scope, cards: placed, updatedAt: data.previewUpdatedAt, agent: { ...recurring.agent, askRerun } })
  const cards = editor.cards
  // The View query filters and counts by owner and column, so it gets the placed cards; a
  // placement change (a task moved columns) asks it again.
  const placedKey = useMemo(() => placed.filter(card => card.agent).map(card => `${card.id}:${card.column}:${card.owner}`).join('|'), [placed])
  // The header count comes from the attention feed, read every 15 s; the columns from this board's
  // own reads. When delegated work enters or leaves Needs you here (a usage limit to check, a sent
  // change request), read the feed now, so the count agrees with the column within one read.
  const attentionKey = useMemo(() => needsYouKey(placed), [placed])
  useEffect(() => {
    refreshAttention()
  }, [attentionKey])
  const board = useBoardView({
    scope: data.scope,
    envelope: view.screen === 'board' ? { ...envelope, cards: placed } : null,
    cards,
    updatedAt: `${data.previewUpdatedAt}|${placedKey}`
  })
  // Default order keeps the admission queue in Ready for Agent and active work before waits.
  const arranged = useMemo(() => (board.view.sort === 'default' ? keepAgentOrder(board.arranged) : board.arranged), [board.arranged, board.view.sort])
  const toggleDone = () => board.setView(current => ({ ...current, done: current.done === 'all' ? 'recent' : 'all' }))
  const looseTask = useTaskOpener({ cards: view.screen === 'board' ? cards : null, occurrences: recurring.data, occurrencesFailed: Boolean(recurring.error), openId, refresh: data.refresh, setOpenId })
  // A task opened from the reconnect notice is on screen too: its own toast stays away.
  useEffect(() => {
    setVisibleTask('changes', loose ? { taskId: loose.taskId } : null)
  }, [loose?.taskId])
  useEffect(() => () => setVisibleTask('changes', null), [])
  // Accepting or replying inside the task dialog changes where its card belongs. Those go straight
  // to Hermes, not through the board's own actions, so the board rereads when they say so.
  useEffect(() => {
    const onChange = () => {
      void data.refresh()
      void delegation.reread?.()
      void recurring.reread?.()
      // An accepted or stopped task may leave the reminder yours again: the owner's check takes
      // this Mac's claim line off it, so ask for one now (nothing else may be ticking).
      void Promise.all([delegation.tick?.({ after: true }), recurring.tick?.({ after: true })]).then(() => data.refresh())
    }
    window.addEventListener('rk:task-changed', onChange)
    return () => window.removeEventListener('rk:task-changed', onChange)
  }, [data.refresh, delegation.reread, recurring.reread])

  const save = (ids, { revising }) => {
    const firstRun = firstRunSave || !revising
    setFirstRunSave(firstRun)
    setChoosing(true)
    data.save.mutate(ids, {
      onSuccess: next => {
        if (next.status === 'ready' || next.status === 'empty_list') {
          setChoosing(false)
          setListDraft(null)
          setFirstRunSave(false)
          setReviewing(firstRun)
        }
      }
    })
  }

  // Radix returns focus only to a DialogTrigger; put it back on the card that opened the dialog
  // (unless a control outside it has focus by the time Radix reports the close).
  const restoreCardFocus = event => {
    event.preventDefault()
    if (!focusLeftBehind(event, document)) return
    const card = openId && document.querySelector(`[data-card-id="${CSS.escape(openId)}"]`)
    ;(card || document.querySelector('.rk-card'))?.focus()
  }

  // A task with no card (opened from "N need you", a notice or a notification): back to that chip.
  const restoreChipFocus = event => {
    event.preventDefault()
    if (!focusLeftBehind(event, document)) return
    ;(document.querySelector('button.rk-attn-chip') ?? document.querySelector('.rk-card'))?.focus()
  }

  // Forms return focus to the card they edited, or to the button that opened them (New until the
  // created card appears, Title labels for its own form). The empty board's New reminder counts
  // while it is still on screen.
  const formOpener = useRef(null)
  const restoreFormFocus = event => {
    event.preventDefault()
    if (!focusLeftBehind(event, document)) return
    const id = editor.form?.cardId
    const opener = editor.form?.mode === 'labels' ? '[aria-label="Title labels"]' : '[data-rk-new]'
    const from = formOpener.current?.isConnected && !formOpener.current.disabled ? formOpener.current : null
    formOpener.current = null
    const target = id ? document.querySelector(`[data-card-id="${CSS.escape(id)}"]`) : (from ?? document.querySelector(`${opener}:not(:disabled)`) ?? document.querySelector('.rk-lists-trigger'))
    target?.focus()
  }

  // A repeating reminder waiting on your decision sits in Needs you with no task waiting behind it,
  // so the attention feed doesn't count it: the header chip adds those cards itself.
  const heldSeries = useMemo(() => (view.screen === 'board' ? cards.filter(card => card.agent?.status === 'series_held').map(card => ({ id: card.id, title: splitTitle(card.source.title).text })) : []), [cards, view.screen])
  const header = (
    <PageHeader
      actions={<EditorHeaderActions editor={editor} envelope={envelope} />}
      attention={<AttentionChip held={heldSeries} onOpenCard={setOpenId} />}
      envelope={envelope}
      // While the board can't be read (Hermes unreachable), the picker can't open: say so by disabling, not by opening it minutes later.
      listsDisabled={deriveView({ ...data, reviewing, choosing: true }).screen === 'board'}
      onChangeLists={() => setChoosing(true)}
      onRefresh={refreshFrom}
      pending={data.previewPending}
      pickup={<PickupControl delegation={delegation} fallbackReady={startableReady(view.screen === 'board' ? cards : envelope?.cards)} />}
      showBoardControls={view.screen === 'board'}
      viewControl={<ViewControl board={board} />}
    />
  )

  if (view.screen === 'onboarding') {
    return (
      <div className="rk-page">
        {header}
        <div className="rk-center">
          <Setup
            busyLists={listsWithWork(cards)}
            listDraft={listDraft}
            onListDraft={setListDraft}
            scope={data.scope}
            onCancel={() => {
              setListDraft(null)
              setChoosing(false)
            }}
            onChangeLists={() => {
              setReviewing(false)
              setChoosing(true)
            }}
            onOpenBoard={() => setReviewing(false)}
            onRetry={data.refresh}
            onSave={save}
            pending={data.previewPending}
            pickup={<PickupReview delegation={delegation} fallbackReady={envelope?.ready_count ?? 0} fallbackStart={startableReady(envelope?.cards)} />}
            saving={data.save}
            view={view}
          />
        </div>
      </div>
    )
  }

  if (view.screen === 'problem') {
    return (
      <div className="rk-page">
        {header}
        <div className="rk-center">
          <Problem
            kind={view.problem.kind}
            // Only lists that were read can be chosen from: a read that failed has none to offer.
            lists={view.envelope?.lists?.length > 0}
            onChooseLists={() => setChoosing(true)}
            onRetry={data.refresh}
            pending={data.previewPending}
          />
        </div>
      </div>
    )
  }

  const openCard = openId ? cards.find(card => card.id === openId) : null
  if (openCard) lastOpen.current = taskOf(openCard)
  const openedGone = openId && !openCard && lastOpen.current?.cardId === openId && lastOpen.current.destination?.link_id ? lastOpen.current : null
  const openFinding = item => {
    const card = cards.find(entry => (item.occurrence ? entry.occurrence?.key === item.occurrence : entry.agent?.row?.key === item.key))
    if (card) return setOpenId(card.id)
    if (item.destination?.link_id) setLoose({ taskId: item.taskId, occurrence: item.occurrence, destination: item.destination, title: item.title })
  }

  return (
    <div className="rk-page">
      {header}
      <Notice
        envelope={envelope}
        notice={view.notice}
        onChooseLists={() => setChoosing(true)}
        onNew={event => {
          formOpener.current = event.currentTarget
          editor.openCreate()
        }}
        onRefresh={refreshFrom}
        pending={data.previewPending}
      />
      {!view.notice && <ReconnectNotice onOpen={openFinding} reconnect={reconnect} />}
      <ViewNotice board={board} />
      {board.arranged || board.failed ? (
        <Board
          arranged={arranged}
          cards={cards}
          columns={envelope.columns}
          editor={editor}
          filtered={board.customized}
          lists={envelope.setup.selected_list_ids}
          onOpen={setOpenId}
          onToggleDone={toggleDone}
        />
      ) : (
        // The lanes are there while the first view answer is out; cards land in them.
        <div aria-busy="true" aria-label="Reminders board" className="rk-board" role="group">
          {envelope.columns.map(name => (
            <section className="rk-column" key={name}>
              <header className="rk-column-header">
                <span className="rk-column-name">{name}</span>
              </header>
            </section>
          ))}
        </div>
      )}
      {openedGone && (
          <LooseTaskDialog
            onClose={() => {
              setOpenId(null)
              setAskRerunId(null)
            }}
            onCloseAutoFocus={restoreCardFocus}
            task={openedGone}
          />
        )}
      {loose && <LooseTaskDialog onClose={() => setLoose(null)} onCloseAutoFocus={restoreChipFocus} task={loose} />}
      {openId && !openedGone && (
        <TaskDialog
          actions={
            <>
              {/* While Run again starts (it stops, confirms and reruns), only its busy footer shows. */}
              {!recurring.rerunning(openCard?.id) && (
                <EditorCardActions
                  card={openCard}
                  editor={{
                    ...editor,
                    openEdit: (id, anchorTop) => {
                      setOpenId(null)
                      editor.openEdit(id, anchorTop)
                    }
                  }}
                />
              )}
              <DelegateAction askFirst={askRerunId === openId} card={openCard} delegation={delegation} editor={editor} />
              {!recurring.rerunning(openCard?.id) && <DelegateChoice card={openCard} editor={editor} recurring={recurring} />}
              <AgentActions card={openCard} delegation={delegation} editor={editor} />
              <ElsewhereActions card={openCard} delegation={delegation} editor={editor} recurring={recurring} />
              <TheirTaskAction card={openCard} />
              <OccurrenceActions card={openCard} editor={editor} onClose={() => setOpenId(null)} recurring={recurring} />
            </>
          }
          card={openCard}
          onClose={() => {
            setOpenId(null)
            setAskRerunId(null)
          }}
          onCloseAutoFocus={restoreCardFocus}
        />
      )}
      {looseTask}
      <EditorLayer cards={cards} editor={editor} envelope={envelope} onCloseAutoFocus={restoreFormFocus} />
    </div>
  )
}

/** The task behind a card, for its dialog after the reminder is gone: its stored binding. */
function taskOf(card) {
  const row = card.agent?.row
  return {
    cardId: card.id,
    taskId: row?.task_id ?? null,
    occurrence: card.occurrence?.key ?? null,
    destination: row?.destination ?? card.occurrence?.destination ?? null,
    title: splitTitle(card.source.title).text
  }
}

function PageHeader({ actions, attention, envelope, listsDisabled, onChangeLists, onRefresh, pending, pickup, showBoardControls, viewControl }) {
  const names = selectedListNames(envelope)
  const updated = timeOf(envelope?.observed_at)

  return (
    <header className="rk-header">
      <h1>Reminders</h1>
      {showBoardControls && (
        <Tip label={names.length > 1 ? `Choose lists · ${names.join(', ')}` : 'Choose lists'}>
          <Button aria-label={`Choose lists: ${names.join(', ') || 'none chosen'}`} className="rk-lists-trigger" disabled={listsDisabled} onClick={onChangeLists} size="sm" variant="ghost">
            <Codicon name="list-unordered" size="0.8rem" />
            <span>{names.length ? names.join(', ') : 'Choose lists'}</span>
          </Button>
        </Tip>
      )}
      {showBoardControls && viewControl}
      {showBoardControls && (
        <div className="rk-header-actions">
          {attention}
          {pickup}
          <Tip label={updated ? `Refresh · updated ${updated}` : 'Refresh'}>
            <Button aria-label="Refresh" disabled={pending} onClick={onRefresh} size="icon-xs" variant="ghost">
              <Codicon name="refresh" size="0.85rem" spinning={pending} />
            </Button>
          </Tip>
          {actions}
        </div>
      )}
    </header>
  )
}

function Notice({ envelope, notice, onChooseLists, onNew, onRefresh, pending }) {
  if (!notice) {
    if (envelope.status === 'empty_list') {
      const names = selectedListNames(envelope)
      // Lists chosen but empty: the next step is a first reminder; other lists stay one click away.
      const canCreate = names.length > 0 && Boolean(onNew)
      return (
        <div className="rk-notice rk-enter" role="status">
          <Codicon name="info" size="0.85rem" />
          <span className="rk-notice-text">
            {names.length ? `No reminders in ${names.join(', ')}.` : 'No lists selected.'}
          </span>
          <div className="rk-notice-actions">
            <Button onClick={onChooseLists} size="xs" variant={canCreate ? 'ghost' : 'secondary'}>
              Choose lists
            </Button>
            {canCreate && (
              <Button onClick={onNew} size="xs" variant="secondary">
                New reminder
              </Button>
            )}
          </div>
        </div>
      )
    }
    return null
  }

  const time = timeOf(envelope.observed_at) ?? 'earlier'
  const text = (NOTICES[notice.kind] ?? NOTICES.refresh_failed).replace('{time}', time)
  const checking = notice.kind === 'checking'

  return (
    <div className="rk-notice rk-enter" data-tone={checking ? undefined : 'warn'} role="status">
      <Codicon name={checking ? 'loading' : 'warning'} size="0.85rem" spinning={checking} />
      <span className="rk-notice-text">{text}</span>
      {!checking && (
        <div className="rk-notice-actions">
          {notice.kind === 'access_denied' && (
            <Button onClick={openPrivacySettings} size="xs" variant="ghost">
              Open Privacy Settings
            </Button>
          )}
          {notice.kind === 'list_unavailable' ? (
            <Button onClick={onChooseLists} size="xs" variant="secondary">
              Choose lists
            </Button>
          ) : (
            <Button disabled={pending} onClick={onRefresh} size="xs" variant="secondary">
              {pending ? 'Checking…' : notice.kind === 'access_denied' ? 'Check again' : 'Try again'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

const PROBLEM_ICONS = {
  unavailable_host: 'debug-disconnect',
  auth: 'lock',
  backend_missing: 'extensions',
  access_denied: 'lock',
  list_unavailable: 'list-unordered',
  persistence_failed: 'database'
}

export function Problem({ kind, lists = true, onChooseLists, onRetry, pending }) {
  const copy = PROBLEMS[kind] ?? PROBLEMS.read_failure
  const choose = copy.action === 'Choose lists'

  return (
    <div className="rk-problem rk-enter" role="alert">
      <Codicon className="rk-problem-icon" name={PROBLEM_ICONS[kind] ?? 'warning'} size="1.25rem" />
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <div className="rk-problem-actions">
        {kind === 'access_denied' && (
          <Button onClick={openPrivacySettings} size="sm" variant="secondary">
            Open Privacy Settings
          </Button>
        )}
        {kind === 'read_failure' && lists && (
          <Button onClick={onChooseLists} size="sm" variant="secondary">
            Choose lists
          </Button>
        )}
        <Button disabled={pending} onClick={choose ? onChooseLists : onRetry} size="sm">
          {pending ? 'Checking…' : copy.action}
        </Button>
      </div>
    </div>
  )
}
