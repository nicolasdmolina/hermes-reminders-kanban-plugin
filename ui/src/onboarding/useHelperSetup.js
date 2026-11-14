import { useMutation, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useRef } from 'react'

import { getHelperSetup, isRouted, postHelperSetup, queryKey } from '../api/client.js'

/** Status reads are passive. Only a deliberate action can prepare the helper or open Apple's installer. */
export function useHelperSetup(scope, enabled, onReady) {
  const client = useQueryClient()
  const key = queryKey(scope, 'helper-setup')
  const busy = useRef(false)
  const query = useQuery({
    queryKey: key,
    queryFn: () => getHelperSetup(scope),
    enabled: () => enabled && isRouted(scope),
    retry: false,
    staleTime: 0
  })
  const mutation = useMutation({
    mutationFn: action => action === 'check' ? getHelperSetup(scope) : postHelperSetup(scope, action),
    onSuccess: answer => {
      if (!isRouted(scope)) return
      client.setQueryData(key, answer)
      if (answer.status === 'ready') void onReady()
    },
    onSettled: () => { busy.current = false }
  })
  return {
    status: query.data?.status,
    error: mutation.isError ? mutation.error : query.isError ? query.error : null,
    pending: query.isFetching || mutation.isPending,
    action: mutation.variables,
    run: action => {
      if (busy.current || query.isFetching || !isRouted(scope)) return
      busy.current = true
      mutation.mutate(action)
    }
  }
}
