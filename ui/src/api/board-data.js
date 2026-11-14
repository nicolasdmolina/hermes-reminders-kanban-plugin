// Board data: saved setup first (no Reminders access), then the live board. The board
// comes from GET /human/board: the preview envelope plus human progress, title labels
// and per-card capabilities (human-contract.md).
import { useMutation, useQuery, useQueryClient } from '@hermes/plugin-sdk'

import { classifyError } from '../lib/state.js'
import { getSetup, isRouted, putSetup, queryKey, useScope } from './client.js'
import { getHumanBoard } from './human.js'

// Each preview read launches the native helper, so poll gently; focus and the
// refresh control cover the moments a user is actually looking.
const PREVIEW_POLL_MS = 60_000

const failure = query => (query.isError ? classifyError(query.error) : null)

export function useBoardData() {
  const scope = useScope()
  const client = useQueryClient()
  // Evaluated when React Query decides to fetch, not at render: after a host switch the old
  // key must not fetch from the new connection before React re-keys it.
  const routed = () => isRouted(scope)

  const setup = useQuery({
    queryKey: queryKey(scope, 'setup'),
    queryFn: () => getSetup(scope),
    enabled: routed,
    retry: false,
    staleTime: Infinity
  })

  const preview = useQuery({
    queryKey: queryKey(scope, 'preview'),
    queryFn: () => getHumanBoard(scope),
    enabled: setup.isPending ? false : routed,
    retry: false,
    staleTime: 10_000,
    refetchInterval: PREVIEW_POLL_MS,
    refetchOnWindowFocus: true
  })

  const save = useMutation({
    mutationFn: ids => putSetup(scope, ids),
    onSuccess: envelope => {
      // A late answer for another connection must not paint here.
      if (!isRouted(scope)) return
      client.setQueryData(queryKey(scope, 'preview'), envelope)
      // PUT /setup answers with the plain preview; read the human board for actions.
      void client.invalidateQueries({ queryKey: queryKey(scope, 'preview') })
    }
  })

  return {
    scope,
    setup: setup.data,
    preview: preview.data,
    setupError: failure(setup),
    previewError: failure(preview),
    previewPending: preview.isFetching,
    previewUpdatedAt: preview.dataUpdatedAt,
    refresh: () => {
      if (setup.isError) void setup.refetch()
      return preview.refetch()
    },
    save
  }
}
