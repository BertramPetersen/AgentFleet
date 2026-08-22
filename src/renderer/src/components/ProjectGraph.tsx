import { useMemo } from 'react';
import type { ProjectTask } from '@/store/projects';
import { layoutGraph, NODE_W, NODE_H, type NodeState } from '@/store/graphLayout';
import { useStore } from '@/store/store';

/**
 * PROJECT GRAPH — the backlog as a pipeline instead of a list.
 *
 * Dependencies flow left to right; every ticket is a node colored by what it
 * is actually doing: waiting on upstream work, READY to start (deps done,
 * nobody on it — the spin-up-concurrency signal, counted in the header),
 * in progress, blocked on a human, in review, done. Edges hold their tint
 * until the upstream card completes, so "what is still missing" is literally
 * the unfinished paths through the picture.
 */

const STATE_STYLE: Record<NodeState, { stroke: string; bg: string; text: string; label: string }> = {
  waiting: { stroke: 'var(--cth-ink-300)', bg: 'var(--cth-cream-200)', text: 'var(--cth-ink-500)', label: 'waiting on deps' },
  ready:   { stroke: 'var(--cth-status-thinking-bd)', bg: 'var(--cth-status-thinking-bg)', text: 'var(--cth-status-thinking)', label: 'ready — start now' },
  doing:   { stroke: 'var(--cth-status-working-bd)', bg: 'var(--cth-status-working-bg)', text: 'var(--cth-status-working)', label: 'in progress' },
  blocked: { stroke: 'var(--cth-status-blocked-bd)', bg: 'var(--cth-status-blocked-bg)', text: 'var(--cth-status-blocked)', label: 'blocked' },
  review:  { stroke: 'var(--cth-status-compacting-bd)', bg: 'var(--cth-status-compacting-bg)', text: 'var(--cth-status-compacting)', label: 'in review' },
  done:    { stroke: 'var(--cth-status-success-bd)', bg: 'var(--cth-status-success-bg)', text: 'var(--cth-status-success)', label: 'done' }
};

export function ProjectGraph({ tasks, onOpenTask }: {
  tasks: ProjectTask[];
  /** Jump to the board with this card expanded. */
  onOpenTask: (id: string) => void;
}) {
  const agents = useStore((s) => s.agents);
  const g = useMemo(() => layoutGraph(tasks), [tasks]);
  const byId = useMemo(() => new Map(g.nodes.map((n) => [n.task.id, n])), [g]);
  const done = g.nodes.filter((n) => n.state === 'done').length;

  if (tasks.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'grid', placeItems: 'center', padding: 24,
        fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', textAlign: 'center'
      }}>
        <div>
          <div style={{ fontSize: 'var(--cth-text-body-md)', marginBottom: 6 }}>Nothing to draw yet.</div>
          <div style={{ fontSize: 'var(--cth-text-body-sm)', maxWidth: 420, lineHeight: 1.5 }}>
            Cards appear here as the plan grows — link them with dependencies in a
            card's detail and the pipeline draws itself.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* progress strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '6px 12px',
        borderBottom: '1px solid var(--cth-ink-100)', flexWrap: 'wrap',
        fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)'
      }}>
        <span style={{ color: 'var(--cth-ink-700)' }}>
          {done} of {g.nodes.length} done
        </span>
        {g.readyNow > 0 && (
          <span style={{ color: 'var(--cth-status-thinking)', fontWeight: 600 }}>
            {g.readyNow} ready to run in parallel right now
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
          {(Object.keys(STATE_STYLE) as NodeState[]).map((s) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: STATE_STYLE[s].text, display: 'inline-block' }} />
              {STATE_STYLE[s].label}
            </span>
          ))}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <svg width={g.width} height={g.height} style={{ display: 'block' }}>
          <defs>
            <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--cth-ink-300)" />
            </marker>
          </defs>

          {g.edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x - 2;
            const y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={e.satisfied ? 'var(--cth-ink-100)' : 'var(--cth-ink-300)'}
                strokeWidth={1.5}
                strokeDasharray={e.satisfied ? undefined : '5 4'}
                markerEnd="url(#dep-arrow)"
              />
            );
          })}

          {g.nodes.map((n) => {
            const st = STATE_STYLE[n.state];
            const assignee = n.task.assignee ? agents.find((a) => a.id === n.task.assignee)?.name ?? n.task.assignee : null;
            return (
              <g
                key={n.task.id}
                transform={`translate(${n.x}, ${n.y})`}
                onClick={() => onOpenTask(n.task.id)}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill="var(--cth-cream-200)"
                  stroke={st.stroke}
                  strokeWidth={n.state === 'ready' ? 2 : 1}
                />
                <text x={12} y={22} style={{
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600,
                  fill: 'var(--cth-ink-900)'
                }}>
                  {n.task.title.length > 30 ? `${n.task.title.slice(0, 29)}…` : n.task.title}
                </text>
                <rect x={10} y={32} width={9} height={9} rx={2.5} fill={st.text} />
                <text x={25} y={40} style={{
                  fontFamily: 'var(--cth-font-ui)', fontSize: 10.5, fill: st.text, fontWeight: 600
                }}>
                  {st.label}
                </text>
                {assignee && (
                  <text x={NODE_W - 12} y={40} textAnchor="end" style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 10.5, fill: 'var(--cth-ink-500)'
                  }}>
                    {assignee.length > 14 ? `${assignee.slice(0, 13)}…` : assignee}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
