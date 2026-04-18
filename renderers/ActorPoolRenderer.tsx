// Plugin renderer for Actor Pool — loaded lazily by HUD via esbuild
// Uses window.__JARVIS_REACT (shared React instance)
// Communicates with HUD via CustomEvents on window

const { useState, useRef, useEffect } = (window as any).__JARVIS_REACT as typeof import('react')
const h = ((window as any).__JARVIS_REACT as typeof import('react')).createElement

const ACTOR_BASE = 'http://localhost:50052/plugins/actors'

export default function ActorPoolRenderer({ state }: { state: any }) {
  const data = state.data as any
  const actors = (data?.actors ?? []) as Array<{ id: string; role: string; status: string; tasks: number }>
  const roles = (data?.roles ?? []) as Array<{ id: string; name: string; description: string }>
  const total = data?.total ?? 0
  const maxActors = data?.maxActors ?? 5

  const [showForm, setShowForm] = useState(false)
  const [actorName, setActorName] = useState('')
  const [selectedRole, setSelectedRole] = useState('')
  const [creating, setCreating] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showForm && nameInputRef.current) {
      nameInputRef.current.focus()
    }
  }, [showForm])

  useEffect(() => {
    if (roles.length > 0 && !selectedRole) {
      setSelectedRole(roles[0].id)
    }
  }, [roles, selectedRole])

  const statusColor = (s: string) => {
    switch (s) {
      case 'running': return '#fa4'
      case 'waiting_tools': return 'var(--status-auth)'
      case 'idle': return '#4a8'
      case 'stopped': return '#666'
      default: return 'var(--color-muted)'
    }
  }

  const onActorClick = (name: string) => {
    window.dispatchEvent(new CustomEvent('actor-open-chat', { detail: { name } }))
  }

  const onActorKill = (e: any, name: string) => {
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('actor-kill', { detail: { name } }))
  }

  const handleCreate = async () => {
    const name = actorName.trim().toLowerCase().replace(/\s+/g, '-')
    if (!name || !selectedRole) return
    setCreating(true)
    try {
      await fetch(`${ACTOR_BASE}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role: selectedRole }),
      })
    } catch {}
    setCreating(false)
    setActorName('')
    setShowForm(false)
  }

  const handleKeyDown = (e: any) => {
    if (e.key === 'Enter') { e.preventDefault(); handleCreate() }
    if (e.key === 'Escape') { setShowForm(false); setActorName('') }
  }

  const isFull = total >= maxActors

  return h('div', { className: 'panel' },
    h('div', { className: 'row', style: { display: 'flex', alignItems: 'center' } },
      h('span', { className: 'label', style: { flex: 1 } }, 'actors'),
      h('span', { className: 'value', style: { marginRight: '6px' } }, `${total}/${maxActors}`),
      !isFull && !showForm && h('span', {
        onClick: () => setShowForm(true),
        style: {
          cursor: 'pointer', color: '#4af', fontSize: '12px', fontWeight: 'bold',
          lineHeight: 1, width: '14px', height: '14px', display: 'flex',
          alignItems: 'center', justifyContent: 'center', borderRadius: '3px',
          border: '1px solid rgba(68, 170, 255, 0.3)',
        },
        title: 'Create new actor',
      }, '+'),
    ),

    showForm && h('div', { style: { padding: '4px 8px 6px', borderTop: '1px solid rgba(255,255,255,0.06)' } },
      h('input', {
        ref: nameInputRef, type: 'text', value: actorName,
        onChange: (e: any) => setActorName(e.target.value),
        onKeyDown: handleKeyDown, placeholder: 'actor name',
        style: {
          width: '100%', background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(68,170,255,0.3)', borderRadius: '3px',
          color: '#e0e0e0', fontSize: '10px', padding: '3px 6px',
          outline: 'none', fontFamily: 'inherit', marginBottom: '4px', boxSizing: 'border-box',
        },
      }),
      h('select', {
        value: selectedRole, onChange: (e: any) => setSelectedRole(e.target.value),
        style: {
          width: '100%', background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(68,170,255,0.3)', borderRadius: '3px',
          color: '#e0e0e0', fontSize: '10px', padding: '3px 6px',
          outline: 'none', fontFamily: 'inherit', marginBottom: '4px', boxSizing: 'border-box',
        },
      }, ...roles.map(r => h('option', { key: r.id, value: r.id }, `${r.id} — ${r.description.slice(0, 50)}`))),
      h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        h('span', {
          onClick: () => { setShowForm(false); setActorName('') },
          style: { cursor: 'pointer', color: '#666', fontSize: '9px', padding: '2px 6px' },
        }, 'cancel'),
        h('span', {
          onClick: handleCreate,
          style: {
            cursor: creating || !actorName.trim() ? 'default' : 'pointer',
            color: creating || !actorName.trim() ? '#444' : '#4af',
            fontSize: '9px', padding: '2px 6px', borderRadius: '3px',
            border: '1px solid rgba(68,170,255,0.3)',
          },
        }, creating ? '...' : 'create'),
      ),
    ),

    ...actors.map((a: any) =>
      h('div', {
        className: 'row', key: a.id,
        onClick: () => onActorClick(a.id),
        style: { cursor: 'pointer', display: 'flex', alignItems: 'center' },
      },
        h('span', { className: 'dot', style: { color: statusColor(a.status) } }, '●'),
        h('span', { className: 'label', style: { flex: 1 } }, a.id),
        h('span', { className: 'rightValue', style: { marginRight: '6px' } }, `${a.role} #${a.tasks}`),
        h('span', {
          onClick: (e: any) => onActorKill(e, a.id),
          style: { cursor: 'pointer', color: '#666', fontSize: '9px', lineHeight: 1 },
          title: `Kill ${a.id}`,
        }, '✕'),
      ),
    ),

    actors.length === 0 && !showForm && h('div', { className: 'row' },
      h('span', { className: 'muted' }, 'no actors'),
    ),
  )
}
