// Board: five columns of reminder cards. Cards are buttons, so Tab and Enter work
// everywhere; arrow keys move focus between cards, and Option+Left/Right moves a card
// between columns (the drag equivalent). Drag, moves and reasons come from `editor`
// (ui/src/editor/); without it the board is read-only.
import { Button, Codicon } from '@hermes/plugin-sdk'
import { useLayoutEffect, useRef, useState } from 'react'

import { AgentStatus } from '../delegation/Agent.jsx'
import { CardNotice } from '../editor/Editor.jsx'

import { completedLabel, dueInfo, groupCards, splitTitle } from '../lib/cards.js'
import { doneOccurrenceLabel, occurrenceDateLabel, repeatLabel } from '../lib/occurrences.js'
import { defineStyles } from '../styles.js'
import { TaskLinkMark } from '../task-link/TaskLinkMark.jsx'
import css from './board.css'

defineStyles(css)

const KEYS = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] }

export function Board({ arranged, cards, columns, editor, filtered = false, lists, onOpen, onToggleDone }) {
  const ref = useRef(null)
  const now = new Date()
  // `arranged` is the View's answer (ui/src/views/): visible cards in display order, Done's
  // 7-day window with its full total, and the unfiltered Needs you count. Without one the
  // board shows every card in response order.
  const groups = arranged?.groups ?? groupCards(columns, cards)
  const done = arranged?.done ?? null
  const countOf = group =>
    group.name === 'Done' && done ? done.total : group.name === 'Needs you' && arranged ? arranged.needsYou.total : group.cards.length
  const showList = (lists?.length ?? 0) > 1
  // One Tab stop for the whole board: the card focus was last on, else the first card. Arrow
  // keys move between cards from there, so Tab goes past the board instead of through every card.
  const [lastFocused, setLastFocused] = useState(null)
  const shown = groups.flatMap(group => group.cards)
  // A board with no reminders at all says so once, in the notice above it, not five more times in
  // the lanes. (One whose only reminders are old completions still labels its empty lanes.)
  const tabStop = shown.some(card => card.id === lastFocused) ? lastFocused : shown[0]?.id
  const drag = editor?.drag.state

  // Slides, drop landings and focus queued by moves play once the new layout exists.
  useLayoutEffect(() => editor?.motion.flush())

  // Show all has two homes (beside the empty-lane line, and at the lane's foot). When the answer
  // swaps one for the other, keyboard focus follows to the new one instead of falling to the page.
  const doneToggled = useRef(null)
  const toggleDone = () => {
    doneToggled.current = { all: Boolean(done?.all) }
    onToggleDone()
  }
  useLayoutEffect(() => {
    // Only once, when the answer lands: after that, focus is the user's to move.
    if (!doneToggled.current || doneToggled.current.all === Boolean(done?.all)) return
    doneToggled.current = null
    const active = document.activeElement
    if (active?.isConnected && active !== document.body) return
    const lane = ref.current?.querySelector('[data-rk-column="Done"]')
    ;(lane?.querySelector('.rk-show-all') ?? lane?.querySelector('[data-rk-card]'))?.focus()
  })

  const onKeyDown = event => {
    const step = KEYS[event.key]
    const from = event.target.closest?.('[data-rk-card]')
    if (editor && step && from && event.altKey && step[1] === 0 && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      editor.keyMove(from.dataset.cardId, step[0])
      return
    }
    if (!step || !from || event.altKey || event.metaKey || event.ctrlKey) return
    const col = Number(from.dataset.col)
    const row = Number(from.dataset.row)
    let target = null
    if (step[0] === 0) {
      target = ref.current.querySelector(`[data-col="${col}"][data-row="${row + step[1]}"]`)
    } else {
      // Jump to the nearest column that has cards, keeping the row where possible.
      for (let c = col + step[0]; c >= 0 && c < groups.length && !target; c += step[0]) {
        const size = groups[c].cards.length
        if (size) target = ref.current.querySelector(`[data-col="${c}"][data-row="${Math.min(row, size - 1)}"]`)
      }
    }
    if (target) {
      event.preventDefault()
      target.focus()
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  return (
    <div
      aria-label="Reminders board"
      className="rk-board"
      onFocus={event => {
        const id = event.target.closest?.('[data-rk-card]')?.dataset.cardId
        if (id) setLastFocused(id)
      }}
      onKeyDown={onKeyDown}
      ref={ref}
      role="group"
    >
      {groups.map((group, col) => {
        const over = drag?.over === group.name && group.name !== cards.find(card => card.id === drag.cardId)?.column
        const refused = over && drag.verdict?.refused ? drag.verdict.reason : null
        return (
          <section
            aria-label={`${group.name}, ${countOf(group)}`}
            className="rk-column"
            data-drop={over ? (refused ? 'refused' : 'ok') : undefined}
            data-rk-column={group.name}
            key={group.name}
          >
            <header className="rk-column-header">
              <span className="rk-column-name">{group.name}</span>
              <span className="rk-column-count">{countOf(group)}</span>
            </header>
            {refused && (
              <div className="rk-drop-reason" role="status">
                <Codicon name="circle-slash" size="0.7rem" />
                <span>{refused}</span>
              </div>
            )}
            <div className="rk-column-body">
              {group.cards.length === 0 ? (
                <div className="rk-column-empty">
                  {group.name === 'Needs you' && arranged?.needsYou.hidden
                    ? `${arranged.needsYou.hidden} hidden by this view`
                    : // Done counts its older completions too: an empty window says that, not "No reminders".
                      group.name === 'Done' && done?.hidden > 0
                      ? 'None in the last 7 days'
                      : filtered
                        ? 'None in this view'
                        : cards.length
                          ? 'No reminders'
                          : null}
                  {/* Nothing in the window: Show all sits with the line that says so, not at the lane's foot. */}
                  {group.name === 'Done' && done?.hidden > 0 && (
                    <Button className="rk-show-all rk-show-all-inline" onClick={toggleDone} size="inline" variant="link">
                      Show all {done.total}
                    </Button>
                  )}
                </div>
              ) : (
                group.cards.map((card, row) => (
                  <Card
                    card={card}
                    col={col}
                    dragging={drag?.cardId === card.id}
                    editor={editor}
                    key={card.id}
                    now={now}
                    onOpen={onOpen}
                    row={row}
                    showList={showList}
                    tabStop={card.id === tabStop}
                  />
                ))
              )}
            </div>
            {/* The way back to the 7-day window only when there is something it would hide or show. */}
            {group.name === 'Done' && done && group.cards.length > 0 && (done.hidden > 0 || done.all) && (
              <Button className="rk-show-all" onClick={toggleDone} size="inline" variant="link">
                {done.all ? 'Show the last 7 days' : `Show all ${done.total}`}
              </Button>
            )}
          </section>
        )
      })}
    </div>
  )
}

function Card({ card, col, dragging, editor, now, onOpen, row, showList, tabStop }) {
  const { text } = splitTitle(card.source.title)
  const due = dueInfo(card.source.due, now)
  // A reminder you finished yourself after stopping Hermes is done like any other.
  const done = card.column === 'Done' && (card.source?.completed || card.agent?.status !== 'stopped')
  const agent = card.owner === 'agent'
  const pending = Boolean(editor?.pending[card.id])
  const notice = editor?.notices[card.id]
  // Agent cards move only where ticket 13 allows (a result to Done); the rest snap back with a reason.
  const movable = Boolean(editor) && (!agent || card.agent?.status === 'result')

  const button = (
    <button
      aria-busy={pending || undefined}
      aria-describedby={notice ? `rk-notice-${card.id}` : undefined}
      aria-keyshortcuts={movable ? (agent ? 'Alt+ArrowRight' : 'Alt+ArrowLeft Alt+ArrowRight') : undefined}
      className="rk-card"
      data-card-id={card.id}
      data-col={col}
      data-done={done}
      data-dragging={dragging || undefined}
      data-just-created={editor?.created === card.id || undefined}
      data-pending={pending || undefined}
      data-rk-card=""
      data-row={row}
      onClick={() => onOpen(card.id)}
      onPointerDown={editor ? event => editor.drag.onPointerDown(card, event) : undefined}
      tabIndex={tabStop ? 0 : -1}
      type="button"
    >
      <span className="rk-card-title" dir="auto">{text}</span>
      <span className="rk-card-meta">
        {done ? (
          <>
            <span aria-label="Completed" className="rk-done-mark" role="img">
              <Codicon name="check" size="0.625rem" />
            </span>
            {completedLabel(card.source.completedAt, now) && <span>{completedLabel(card.source.completedAt, now)}</span>}
            {doneOccurrenceLabel(card) && <span className="rk-due">{doneOccurrenceLabel(card)}</span>}
          </>
        ) : (
          <>
            <span aria-label={agent ? 'Agent task' : 'Your reminder'} className="rk-owner" data-owner={agent ? 'agent' : 'you'} role="img">
              <Codicon name={agent ? 'hubot' : 'person'} size="0.75rem" />
            </span>
            {/* A stopped reminder you started yourself is plain work in progress: no "Stopped" beside it. */}
            <AgentStatus agent={card.agent?.status === 'stopped' && (card.column === 'In progress' || done) ? card.linkCopy : (card.agent ?? card.linkCopy)} />
            {(due || repeatLabel(card)) && (
              <span className="rk-due" data-tone={(occurrenceDateLabel(card) ? card.occurrence.entry.overdue : due?.overdue) ? 'overdue' : undefined}>
                {(occurrenceDateLabel(card) ? card.occurrence.entry.overdue : due?.overdue) && <span className="rk-sr">Overdue. </span>}
                {occurrenceDateLabel(card) ?? [due?.near, repeatLabel(card)].filter(Boolean).join(' · ')}
              </span>
            )}
          </>
        )}
        <TaskLinkMark card={card} source={card.source} />
        {showList && <span className="rk-meta-end">{card.source.calendarTitle}</span>}
        {pending && <Codicon aria-label="Saving" className="rk-card-spinner" name="loading" size="0.7rem" spinning />}
      </span>
    </button>
  )
  if (!editor) return button
  return (
    <div className="rk-card-slot">
      {button}
      {notice && (
        <div id={`rk-notice-${card.id}`}>
          <CardNotice cardId={card.id} editor={editor} notice={notice} onOpenCard={onOpen} />
        </div>
      )}
    </div>
  )
}
