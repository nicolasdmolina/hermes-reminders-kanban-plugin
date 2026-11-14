// One View control in the board header: Owner, Repeats, Lists and Sort in a single panel,
// modeled on the Sessions filter menu (an icon trigger that reads as engaged while the view
// is customized, and options that keep the panel open so a whole view is set in one pass).
// The SDK exports no checkbox or radio menu items, so the panel is a menu-surface Popover
// holding the host's SegmentedControl, Select and Checkbox. Also: ViewNotice, the row above
// the board for hidden attention, filtered-empty and a failed view query.
import {
  Button,
  Checkbox,
  Codicon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator
} from '@hermes/plugin-sdk'
import { useId } from 'react'

import { applyReveal, OWNERS, REPEATS, resetView, SORTS, toggleList } from '../lib/views.js'
import { defineStyles } from '../styles.js'
import css from './views.css'

defineStyles(css)

export function ViewControl({ board }) {
  const { customized, lists, setView, view } = board
  const id = useId()
  const set = patch => setView(current => ({ ...current, ...patch }))
  const integrated = lists.map(list => list.id)
  const checked = listId => view.listIds == null || view.listIds.includes(listId)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-description={customized ? 'Filters on' : undefined} className="rk-view-trigger" data-engaged={customized || undefined} size="sm" variant="ghost">
          <Codicon name="list-filter" size="0.8rem" />
          <span>View</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="View" className="rk-view-panel" variant="menu">
        <div className="rk-view-row">
          <span className="rk-view-label" id={`${id}-owner`}>
            Owner
          </span>
          <div aria-labelledby={`${id}-owner`} role="group">
            <SegmentedControl className="rk-view-segments" onChange={owner => set({ owner })} options={OWNERS} value={view.owner} />
          </div>
        </div>
        <div className="rk-view-row">
          <span className="rk-view-label" id={`${id}-repeats`}>
            Repeats
          </span>
          <div aria-labelledby={`${id}-repeats`} role="group">
            <SegmentedControl className="rk-view-segments" onChange={repeats => set({ repeats })} options={REPEATS} value={view.repeats} />
          </div>
        </div>
        <div className="rk-view-row">
          <span className="rk-view-label" id={`${id}-sort`}>
            Sort
          </span>
          <Select onValueChange={sort => set({ sort })} value={view.sort}>
            <SelectTrigger aria-labelledby={`${id}-sort`} className="rk-view-select" size="xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map(option => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {lists.length > 1 && (
          <div className="rk-view-row" data-align="start">
            <span className="rk-view-label" id={`${id}-lists`}>
              Lists
            </span>
            <div aria-labelledby={`${id}-lists`} className="rk-view-lists" role="group">
              {lists.map(list => (
                <label className="rk-view-check" key={list.id}>
                  <Checkbox
                    checked={checked(list.id)}
                    className={checked(list.id) ? undefined : 'rk-view-checkbox-unchecked'}
                    onCheckedChange={() => set({ listIds: toggleList(view.listIds, list.id, integrated) })}
                  />
                  <span>{list.title}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {customized && (
          <>
            <Separator className="rk-view-separator" />
            <Button className="rk-view-reset" onClick={() => setView(resetView)} size="xs" variant="ghost">
              Reset view
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

export function ViewNotice({ board }) {
  const { arranged, empty, failed, pending, retry, setView } = board
  const hidden = arranged?.needsYou.hidden ?? 0

  if (failed) {
    return (
      <div className="rk-notice rk-enter" data-tone="warn" role="status">
        <Codicon name="warning" size="0.85rem" />
        <span className="rk-notice-text">
          {arranged ? "Couldn't update the view." : "Couldn't apply the view. Showing every reminder."}
        </span>
        <div className="rk-notice-actions">
          <Button disabled={pending} onClick={retry} className="rk-view-action" size="xs" variant="secondary">
            {pending ? 'Checking…' : 'Try again'}
          </Button>
        </div>
      </div>
    )
  }

  // Attention outranks an empty board: revealing it also ends the empty state.
  if (hidden > 0) {
    return (
      <div className="rk-notice rk-enter" data-tone="warn" role="status">
        <Codicon name="bell-dot" size="0.85rem" />
        <span className="rk-notice-text">{plural(hidden, 'card in Needs you is', 'cards in Needs you are')} hidden by this view.</span>
        <div className="rk-notice-actions">
          <Button onClick={() => setView(current => applyReveal(current, arranged.needsYou.reveal))} className="rk-view-action" size="xs" variant="secondary">
            Show {hidden === 1 ? 'it' : 'them'}
          </Button>
        </div>
      </div>
    )
  }

  if (empty) {
    return (
      <div className="rk-notice rk-enter" role="status">
        <Codicon name="list-filter" size="0.85rem" />
        <span className="rk-notice-text">No reminders match this view.</span>
        <div className="rk-notice-actions">
          <Button onClick={() => setView(resetView)} className="rk-view-action" size="xs" variant="secondary">
            Reset view
          </Button>
        </div>
      </div>
    )
  }

  return null
}
