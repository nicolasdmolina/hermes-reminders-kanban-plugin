// The Model row's control: which model and effort new agent tasks take (model-choice-contract.md).
// The menu is Hermes' own ModelCatalogMenu, the composer's picker with its per-row thinking and
// effort submenu; this controller only decides what a pick means here: one board-wide choice,
// saved at once. Picking a model leaves effort to the profile; the row's submenu sets one.
import {
  Button,
  Codicon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  host,
  ModelCatalogMenu,
  ModelMenuCloseContext,
  reasoningEffortLabel,
  Tip
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import { useScope } from '../api/client.js'
import { choiceLabel, DEFAULT_CHOICE, isDefault, menuCurrent, sameChoice } from '../lib/model-choice.js'
import './styles.js'

const INHERIT = 'Profile default'

/** delegation: useDelegation. Locked while pickup is switching, so one switch's tasks share a choice. */
export function ModelPicker({ delegation }) {
  return (
    <ModelChoicePicker
      choice={delegation.modelChoice}
      onChange={delegation.setModelChoice}
      disabled={delegation.activating || delegation.deactivating}
      saving={delegation.modelSaving}
      problem={delegation.modelProblem}
    />
  )
}

export function ModelChoicePicker({ choice, onChange, disabled = false, saving = false, problem = null, labelPrefix = 'Model for new tasks', placement }) {
  const [connection, profile] = useScope()
  const [open, setOpen] = useState(false)
  if (!choice) return <span>—</span>
  const save = next => {
    if (!sameChoice(next, choice)) void onChange(next)
  }
  const controller = {
    // Speed is a live-session setting; a task carries model and effort only.
    allowSpeed: false,
    applyPreset: () => {},
    current: menuCurrent(choice),
    presetFor: () => ({}),
    select: (model, provider) => save({ model, provider, effort: null }),
    setOptions: (patch, row) => {
      if (patch.effort !== undefined) save({ model: row.model, provider: row.provider, effort: patch.effort || null })
    }
  }
  const label = choiceLabel(choice, reasoningEffortLabel, INHERIT)
  return (
    <span className="rk-model">
      {problem && (
        <Tip label={problem}>
          <span aria-label={problem} className="rk-stepper-problem" role="img" tabIndex={0}>
            <Codicon name="warning" size="0.75rem" />
          </span>
        </Tip>
      )}
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${labelPrefix}: ${label}`}
            className="rk-model-trigger"
            data-default={isDefault(choice) || undefined}
            data-busy={saving || undefined}
            disabled={disabled}
            size="xs"
            title={choice.provider ? `${choice.provider}: ${label}` : undefined}
            variant="ghost"
          >
            <span className="rk-model-label">{label}</span>
            <Codicon name="chevron-down" size="0.7rem" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="rk-model-menu" side={placement === 'composer' ? 'top' : 'bottom'} sideOffset={placement === 'composer' ? 8 : undefined}>
          <ModelMenuCloseContext.Provider value={() => setOpen(false)}>
            <ModelCatalogMenu
              controller={controller}
              footer={
                isDefault(choice) ? null : (
                  <DropdownMenuItem className="rk-model-default" onSelect={() => save(DEFAULT_CHOICE)}>
                    <Codicon name="discard" size="0.75rem" />
                    Use profile default
                  </DropdownMenuItem>
                )
              }
              gateway={host.getGateway?.() ?? undefined}
              ownerConnectionId={connection}
              profile={profile}
            />
          </ModelMenuCloseContext.Provider>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
