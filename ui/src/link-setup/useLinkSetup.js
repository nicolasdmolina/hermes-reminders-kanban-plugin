// Task-link setup for one connection and profile. The GET runs Tailscale's CLI and probes the
// dashboard, so it is read only while the panel is open (or for the ready row's host name), never
// on the board's own polling. Every write follows a click and rereads setup and delegation, so
// The Agent pickup switch unlocks the moment links are ready or Only on this Mac is chosen.
import { useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useState } from 'react'

import { isRouted, queryKey, useScope } from '../api/client.js'
import { applyLinkSetup, checkLinkAddress, chooseLocalLinks, getLinkSetup } from '../api/task-link-setup.js'
import { classifyError } from '../lib/state.js'

const failed = error => (classifyError(error).kind === 'superseded' ? null : { status: 'unavailable' })

export function useLinkSetup({ enabled = true } = {}) {
  const scope = useScope()
  const client = useQueryClient()
  const key = queryKey(scope, 'link-setup')
  const query = useQuery({
    queryKey: key,
    queryFn: () => getLinkSetup(scope),
    enabled: () => enabled && isRouted(scope),
    retry: 1,
    staleTime: 5_000,
    refetchOnWindowFocus: false
  })
  const [busy, setBusy] = useState(null)

  const settle = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: key, exact: true }),
      client.invalidateQueries({ queryKey: queryKey(scope, 'delegation'), exact: true })
    ]).catch(() => {})

  // One write at a time; the answer, or { status: 'unavailable' } when the call itself failed.
  const run = async (name, call) => {
    if (busy) return null
    setBusy(name)
    try {
      return await call()
    } catch (error) {
      return failed(error)
    } finally {
      setBusy(null)
    }
  }

  return {
    // The GET answer, { status: 'unavailable' } when it couldn't be read, or undefined while loading.
    setup: query.isError ? failed(query.error) ?? undefined : query.data,
    loading: query.isPending || (query.isFetching && !query.data),
    busy,
    // A reread in flight (it runs Tailscale's CLI, so it can take seconds): Check again says so.
    fetching: query.isFetching,
    reread: () => client.refetchQueries({ queryKey: key, exact: true }),
    check: address => run('check', () => checkLinkAddress(scope, address)),
    apply: body =>
      run('apply', async () => {
        const answer = await applyLinkSetup(scope, body)
        await settle()
        return answer
      }),
    local: () =>
      run('local', async () => {
        const answer = await chooseLocalLinks(scope)
        await settle()
        return answer
      })
  }
}
