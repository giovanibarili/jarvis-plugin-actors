// ActorChatRenderer.tsx — Reuses the core ChatPanel component for actor conversations.
// Opens as an ephemeral HUD panel when user clicks an actor in the pool.

export default function ActorChatRenderer({ state }: { state: any }) {
  const piece = typeof useHudPiece === 'function' ? useHudPiece(state.id) : null
  const data = piece?.data ?? state.data ?? {}
  const actorName = data.actorName ?? 'unknown'
  const actorRole = data.actorRole ?? ''

  // Get ChatPanel from core UI exposed on window
  const ChatPanel = (window as any).__JARVIS_COMPONENTS?.ChatPanel

  if (!ChatPanel) {
    return createElement('div', {
      style: { padding: '12px', color: '#f88', fontFamily: 'monospace', fontSize: '11px' }
    }, '⚠ ChatPanel not available — requires @jarvis/core UI with __JARVIS_COMPONENTS')
  }

  // Use relative URLs — Electron serves everything from the same origin
  return createElement(ChatPanel, {
    streamUrl: `/plugins/actors/${actorName}/stream`,
    sendUrl: `/plugins/actors/${actorName}/send`,
    abortUrl: `/plugins/actors/${actorName}/abort`,
    historyUrl: `/plugins/actors/${actorName}/history`,
    assistantLabel: actorName.toUpperCase(),
    features: { slashMenu: false, images: true, abort: true, compaction: false },
    userLabel: (source?: string) => {
      if (!source || source === 'you' || source === 'chat') return 'YOU'
      if (source === 'jarvis') return 'JARVIS'
      return source.toUpperCase()
    },
    userLabelColor: (source?: string) => {
      if (!source || source === 'you' || source === 'chat') return 'var(--chat-user-label)'
      if (source === 'jarvis') return '#4af'
      return '#4af'
    },
  })
}
