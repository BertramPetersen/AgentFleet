import { useEffect, useMemo, useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { agentsInProject, type Project } from '@/store/projects';
import { useFleetTelemetry, totalTokens } from '@/hooks/useTelemetry';
import { PixelBadge } from './PixelBadge';
import { AgentAvatar } from './AgentAvatar';
import { Icon } from './Icon';

/**
 * FLEET — the fleet-wide answer to "is everyone on track?".
 *
 * Every column here already existed in the main process: the harness writes a
 * fleet snapshot every 8s and the OTel collector streams usage and tool spans.
 * Until now only the orchestrator agent ever read them — a human had to click
 * one avatar at a time and infer the rest. This puts the whole floor on one
 * screen, sorted by the thing you actually want to know first: who needs you.
 */

type SortKey = 'attention' | 'name' | 'project' | 'status' | 'context' | 'spend' | 'activity';

/** How loudly a row should shout, high to low. Drives the default sort, so the
 *  agent that is stuck on a human sits at the top without being hunted for. */
const ATTENTION: Record<string, number> = {
  blocked: 100,
  looping: 90,
  waiting: 70,
  compacting: 40,
  working: 30,
  thinking: 30,
  success: 20,
  idle: 10,
  ghost: 0
};

const BREAKER_LABEL: Record<string, string> = {
  healthy: 'ok',
  steering: 'steering',
  constrained: 'constrained',
  stopped: 'stopped'
};

function usd(n: number | undefined): string {
  if (n === undefined) return '—';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function ago(ts: number | undefined): string {
  if (!ts) return '—';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

// Column widths are tuned to survive the project rail: the rail took 208px off
// the pane, and the first pass overflowed into a horizontal scrollbar. Fixed
// columns stay only where the content genuinely has a fixed width.
const HEAD: { key: SortKey; label: string; width: string; align?: 'right' }[] = [
  { key: 'name',     label: 'agent',     width: 'minmax(120px, 1.5fr)' },
  { key: 'project',  label: 'project',   width: 'minmax(70px, 0.9fr)' },
  { key: 'status',   label: 'status',     width: '88px' },
  { key: 'activity', label: 'doing now',  width: 'minmax(90px, 1.1fr)' },
  { key: 'context',  label: 'context',    width: 'minmax(96px, 0.9fr)' },
  { key: 'spend',    label: 'spend',      width: '64px', align: 'right' },
  { key: 'attention',label: 'health',     width: 'minmax(84px, 0.9fr)' }
];

const GRID = HEAD.map((h) => h.width).join(' ');

export function FleetTable() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const openInspector = useStore((s) => s.openInspector);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [projects, setProjects] = useState<Project[]>([]);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const { samples, rate, lastTool, breakers } = useFleetTelemetry();

  const [sort, setSort] = useState<SortKey>('attention');
  const [desc, setDesc] = useState(true);
  const [query, setQuery] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  // One id, not per-row state: the only thing hover drives is revealing the
  // row's "open" affordance, which double-click alone left undiscoverable.
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.cth.projectsList?.()
      .then((list) => { if (alive) setProjects(list ?? []); })
      .catch(() => { /* hive off — no scoping available */ });
    return () => { alive = false; };
  }, [activeProjectId]);

  const scope = projects.find((p) => p.id === activeProjectId) ?? null;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inScope = scope ? agentsInProject(agents, scope) : agents;
    const scored = inScope
      .filter((a) => !a.archived)
      .filter((a) => !q
        || a.name.toLowerCase().includes(q)
        || a.project.toLowerCase().includes(q)
        || (a.model ?? '').toLowerCase().includes(q)
        || (lastTool[a.id] ?? '').toLowerCase().includes(q))
      .filter((a) => !onlyAttention || (ATTENTION[a.status] ?? 0) >= 70);

    const value = (a: Agent): number | string => {
      switch (sort) {
        case 'name': return a.name.toLowerCase();
        case 'project': return a.project.toLowerCase();
        case 'status': return a.status;
        case 'context': return (a.contextTokens ?? 0) / Math.max(1, a.contextLimit ?? 1);
        case 'spend': return samples[a.id]?.usd ?? 0;
        case 'activity': return samples[a.id]?.ts ?? 0;
        default: return ATTENTION[a.status] ?? 0;
      }
    };
    return scored.sort((x, y) => {
      const a = value(x); const b = value(y);
      const cmp = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      return desc ? -cmp : cmp;
    });
  }, [agents, scope, query, onlyAttention, sort, desc, samples, lastTool]);

  const needing = agents.filter((a) => !a.archived && (ATTENTION[a.status] ?? 0) >= 70).length;

  const clickHead = (key: SortKey): void => {
    if (key === sort) { setDesc((d) => !d); return; }
    setSort(key);
    setDesc(key !== 'name' && key !== 'project');
  };

  return (
    <div style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)',
      boxShadow: 'var(--cth-panel-border)'
    }}>
      {/* toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        borderBottom: '1px solid var(--cth-ink-100)', flexWrap: 'wrap'
      }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)'
        }}>Fleet</span>
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-ink-500)'
        }}>
          {rows.length} of {(scope ? agentsInProject(agents, scope) : agents).filter((a) => !a.archived).length}
        </span>

        <button
          onClick={() => setOnlyAttention((v) => !v)}
          title="Show only agents blocked on you, waiting, or breaker-armed"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 8px', cursor: 'pointer', border: 'none',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
            background: onlyAttention ? 'var(--cth-coral-light)' : 'var(--cth-paper-200)',
            boxShadow: onlyAttention ? 'inset 0 0 0 1px var(--cth-status-blocked)' : 'var(--cth-panel-border-inset)',
            color: 'var(--cth-ink-900)'
          }}
        >
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: needing ? 'var(--cth-status-blocked)' : 'var(--cth-status-idle)'
          }} />
          needs you {needing > 0 ? `· ${needing}` : ''}
        </button>

        <button
          onClick={() => setAddAgentOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 9px', cursor: 'pointer', border: 'none',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
            background: 'var(--cth-ink-900)', color: 'var(--cth-cream-100)'
          }}
        >
          <Icon name="plus" /> agent
        </button>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by agent, project, model, tool…"
          style={{
            flex: '1 1 180px', minWidth: 120, padding: '4px 8px',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
            background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
            border: 'none', boxShadow: 'var(--cth-panel-border-inset)'
          }}
        />
      </div>

      {/* header row */}
      <div style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10,
        padding: '6px 12px', background: 'var(--cth-cream-200)',
        borderBottom: '1px solid var(--cth-ink-100)'
      }}>
        {HEAD.map((h) => (
          <button
            key={h.key}
            onClick={() => clickHead(h.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              justifyContent: h.align === 'right' ? 'flex-end' : 'flex-start',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: 'var(--cth-font-display)',
              fontSize: 'var(--cth-text-display-sm)',
              textTransform: 'uppercase', letterSpacing: '0.06em',
              color: sort === h.key ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
              minWidth: 0
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.label}</span>
            {sort === h.key && <span aria-hidden>{desc ? '▾' : '▴'}</span>}
          </button>
        ))}
      </div>

      {/* rows */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 && (
          <div style={{
            padding: 24, textAlign: 'center',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-md)',
            color: 'var(--cth-ink-500)'
          }}>
            {agents.length === 0 ? 'No agents yet.' : 'No agents match this filter.'}
          </div>
        )}

        {rows.map((a) => {
          const on = a.id === selectedId;
          const sample = samples[a.id];
          const tokens = sample ? totalTokens(sample) : 0;
          const ctx = a.contextTokens ?? 0;
          const limit = a.contextLimit ?? 0;
          const pct = limit > 0 ? Math.min(1, ctx / limit) : 0;
          const ctxColor = pct >= 0.85 ? 'var(--cth-status-blocked)'
            : pct >= 0.7 ? 'var(--cth-status-looping)'
              : 'var(--cth-status-success)';
          const breaker = breakers[a.id];
          const armed = breaker && breaker.level !== 'healthy';
          const tokPerMin = rate[a.id];

          return (
            <div
              key={a.id}
              data-agent-id={a.id}
              onClick={() => select(a.id)}
              onDoubleClick={() => openInspector(a.id)}
              onMouseEnter={() => setHoverId(a.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === a.id ? null : cur))}
              title="Click to select · double-click to open the inspector"
              style={{
                display: 'grid', gridTemplateColumns: GRID, gap: 10,
                alignItems: 'center', padding: '7px 12px', cursor: 'pointer',
                background: on ? 'var(--cth-cream-200)' : 'transparent',
                boxShadow: [
                  'inset 0 -1px 0 var(--cth-ink-100)',
                  on ? `inset 3px 0 0 var(--cth-${a.accent})` : '',
                  armed ? 'inset 0 0 0 1px var(--cth-status-looping)' : ''
                ].filter(Boolean).join(', '),
                opacity: a.status === 'ghost' ? 0.55 : 1
              }}
            >
              {/* agent */}
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <AgentAvatar name={a.name} accent={a.accent} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
                    color: 'var(--cth-ink-900)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {a.name}{a.isGod ? ' · boss' : ''}
                  </span>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                    color: 'var(--cth-ink-500)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {(a.provider ?? 'claude')}{a.model ? ` · ${a.model}` : ''}
                  </span>
                </span>
              </span>

              {/* project */}
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                color: 'var(--cth-ink-700)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>{a.project || '—'}</span>

              {/* status */}
              <span><PixelBadge status={a.status} /></span>

              {/* doing now */}
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                color: 'var(--cth-ink-700)', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>
                {lastTool[a.id]
                  ? <>{lastTool[a.id]} <span style={{ color: 'var(--cth-ink-500)' }}>· {ago(sample?.ts)}</span></>
                  : <span style={{ color: 'var(--cth-ink-500)' }}>{a.action || '—'}</span>}
              </span>

              {/* context */}
              <span style={{ minWidth: 0 }}>
                <span style={{
                  display: 'block', height: 4, background: 'var(--cth-cream-300)', overflow: 'hidden'
                }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.round(pct * 100)}%`, background: ctxColor }} />
                </span>
                <span style={{
                  fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
                  color: 'var(--cth-ink-500)', whiteSpace: 'nowrap'
                }}>
                  {limit > 0 ? `${compactTokens(ctx)} / ${compactTokens(limit)}` : '—'}
                </span>
              </span>

              {/* spend */}
              <span
                title={sample ? `${compactTokens(tokens)} tokens${tokPerMin ? ` · ${Math.round(tokPerMin)} tok/min` : ''}` : 'no usage recorded yet'}
                style={{
                  fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
                  color: 'var(--cth-ink-900)', textAlign: 'right', whiteSpace: 'nowrap'
                }}
              >{usd(sample?.usd)}</span>

              {/* health */}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                color: armed ? 'var(--cth-status-looping)' : 'var(--cth-ink-500)',
                minWidth: 0
              }}>
                {armed && <Icon name="bell" />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {breaker ? BREAKER_LABEL[breaker.level] ?? breaker.level : (a.ptyId ? 'ok' : 'no process')}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); openInspector(a.id); }}
                  title={`Open ${a.name} in the inspector`}
                  style={{
                    marginLeft: 'auto', padding: '1px 6px', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                    background: 'var(--cth-cream-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                    color: 'var(--cth-ink-900)',
                    visibility: (hoverId === a.id || on) ? 'visible' : 'hidden'
                  }}
                >open ›</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
