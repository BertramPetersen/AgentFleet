import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import {
  agentsInProject, backlogOrder, parseTasks,
  type Project, type ProjectTask, type TaskContract
} from '@/store/projects';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { AgentAvatar } from './AgentAvatar';
import { Icon } from './Icon';

/**
 * BACKLOG — the work of one project, in the order it should be done.
 *
 * The ledger already had status, assignee, dependencies, priority and a human
 * Q&A trail; what it lacked was a project and an explicit order, so "what is
 * next" was unanswerable and every card looked equally urgent. Cards are grouped
 * by status, ordered by rank inside each group, and carry the dispatch contract
 * the orchestrator's prompt already asks for — OBJECTIVE / OUTPUT / TOOLS /
 * BOUNDARIES — as a structured field you can review before the work goes out
 * instead of prose buried in a message body.
 */

const POLL_MS = 5000;

const GROUPS: { status: ProjectTask['status']; label: string; tone: string }[] = [
  { status: 'doing',   label: 'In progress', tone: 'var(--cth-status-working)' },
  { status: 'blocked', label: 'Blocked',     tone: 'var(--cth-status-blocked)' },
  { status: 'todo',    label: 'Ready',       tone: 'var(--cth-status-idle)' },
  { status: 'done',    label: 'Done',        tone: 'var(--cth-status-success)' }
];

function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function BacklogBoard() {
  const agents = useStore((s) => s.agents);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const openInspector = useStore((s) => s.openInspector);

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null); // null = composer closed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    window.cth.hiveTasks?.().then((raw) => setTasks(parseTasks(raw))).catch(() => { /* hive off */ });
    window.cth.projectsList?.().then((list) => setProjects(list ?? [])).catch(() => { /* hive off */ });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const candidates = useMemo(
    () => (project ? agentsInProject(agents.filter((a) => !a.archived), project) : agents.filter((a) => !a.archived)),
    [agents, project]
  );

  const mine = useMemo(() => {
    const scoped = activeProjectId
      ? tasks.filter((t) => t.projectId === activeProjectId)
      : tasks;
    return scoped.slice().sort(backlogOrder);
  }, [tasks, activeProjectId]);

  const mutate = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'the hive rejected that change');
      load();
    } finally {
      setBusy(false);
    }
  };

  const patch = (id: string, p: Partial<ProjectTask>): Promise<void> =>
    // hivePatchTask's param is typed against the engine's HiveTask, which does
    // not know about the four fields P3 added. They round-trip through
    // patchTask's spread merge regardless, so widen at the boundary.
    mutate(() => window.cth.hivePatchTask(id, p as Parameters<typeof window.cth.hivePatchTask>[1]));

  // An inline composer, not window.prompt(): Electron's renderer throws
  // "prompt() is and will not be supported", so the original + task button was
  // silently dead — the exception only surfaced when the console was scanned.
  const addTask = (): void => {
    const title = (draftTitle ?? '').trim();
    if (!title) return;
    const task = {
      id: newTaskId(),
      title,
      status: 'todo' as const,
      dependsOn: [],
      priority: 0,
      createdAt: new Date().toISOString(),
      ...(activeProjectId ? { projectId: activeProjectId } : {})
    };
    setDraftTitle(null);
    void mutate(() => window.cth.hiveAddTask(task as Parameters<typeof window.cth.hiveAddTask>[0]));
  };

  return (
    <div style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)', boxShadow: 'var(--cth-panel-border)'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        borderBottom: '1px solid var(--cth-ink-100)', flexWrap: 'wrap'
      }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)'
        }}>{project ? project.name : 'All projects'}</span>
        {project && (
          <span style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
            color: 'var(--cth-ink-500)'
          }}>{project.repoPath}</span>
        )}
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-ink-500)'
        }}>{mine.filter((t) => t.status !== 'done').length} open</span>
        <span style={{ marginLeft: 'auto' }}>
          {draftTitle === null ? (
            <PixelButton variant="primary" size="sm" onClick={() => setDraftTitle('')} disabled={busy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="plus" /> task</span>
            </PixelButton>
          ) : (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input
                autoFocus
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTask();
                  if (e.key === 'Escape') setDraftTitle(null);
                }}
                placeholder="one line describing the outcome…"
                style={{
                  width: 260, padding: '4px 9px',
                  borderRadius: 'var(--cth-radius-sm)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                  background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
                  border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', outline: 'none'
                }}
              />
              <PixelButton variant="primary" size="sm" onClick={addTask} disabled={busy || !draftTitle.trim()}>add</PixelButton>
              <PixelButton variant="secondary" size="sm" onClick={() => setDraftTitle(null)}>cancel</PixelButton>
            </span>
          )}
        </span>
      </div>

      {error && (
        <div style={{
          padding: '5px 12px', background: 'var(--cth-status-blocked-bg)',
          borderBottom: '1px solid var(--cth-status-blocked-bd)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-status-blocked)'
        }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {mine.length === 0 && (
          <div style={{
            padding: 28, textAlign: 'center',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-md)',
            color: 'var(--cth-ink-500)'
          }}>
            Nothing in this backlog yet. Add a task, or ask the orchestrator to
            decompose something into cards.
          </div>
        )}

        {GROUPS.map(({ status, label, tone }) => {
          const rows = mine.filter((t) => t.status === status);
          if (rows.length === 0) return null;
          return (
            <div key={status}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '6px 12px', background: 'var(--cth-cream-200)',
                borderTop: '1px solid var(--cth-ink-100)', borderBottom: '1px solid var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
                textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--cth-ink-500)'
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone }} />
                {label} · {rows.length}
              </div>
              {rows.map((task, i) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  agents={candidates}
                  expanded={openId === task.id}
                  first={i === 0}
                  last={i === rows.length - 1}
                  busy={busy}
                  rankable={!!activeProjectId}
                  onToggle={() => setOpenId((cur) => (cur === task.id ? null : task.id))}
                  onPatch={(p) => void patch(task.id, p)}
                  onMove={(dir) => void mutate(() => window.cth.projectsReorderTask(task.id, dir))}
                  onOpenAgent={(id) => openInspector(id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const GRID = '58px minmax(0,1fr) 96px 132px 62px';

function TaskRow({
  task, agents, expanded, first, last, busy, rankable, onToggle, onPatch, onMove, onOpenAgent
}: {
  task: ProjectTask;
  agents: { id: string; name: string; accent: Parameters<typeof AgentAvatar>[0]['accent'] }[];
  expanded: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  /** Rank is per-project, so a card can only be moved while the board is scoped
   *  to one project — in the all-projects view a swap has no defined meaning and
   *  the store would refuse it. */
  rankable: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<ProjectTask>) => void;
  onMove: (dir: 'up' | 'down') => void;
  onOpenAgent: (id: string) => void;
}) {
  const assignee = agents.find((a) => a.id === task.assignee);
  const openAsk = (task.humanQA ?? []).find((q) => !q.a && !q.dismissedAt);

  return (
    <div style={{ boxShadow: 'inset 0 -1px 0 var(--cth-ink-100)' }}>
      <div
        onClick={onToggle}
        style={{
          display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center',
          padding: '7px 12px', cursor: 'pointer',
          background: expanded ? 'var(--cth-cream-200)' : 'transparent'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
          color: 'var(--cth-ink-500)'
        }}>{task.id.slice(-6)}</span>

        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-md)',
            color: 'var(--cth-ink-900)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>{task.title}</span>
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
            color: openAsk ? 'var(--cth-status-blocked)' : 'var(--cth-ink-500)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {openAsk
              ? `waiting on you: ${openAsk.q}`
              : [
                task.contract ? 'contract set' : 'no contract',
                task.dependsOn.length ? `depends on ${task.dependsOn.length}` : '',
                (task.labels ?? []).join(' · ')
              ].filter(Boolean).join(' · ')}
          </span>
        </span>

        <span><PixelBadge status={task.status === 'doing' ? 'working' : task.status === 'blocked' ? 'blocked' : task.status === 'done' ? 'success' : 'idle'} /></span>

        <span style={{ minWidth: 0 }}>
          {assignee ? (
            <span
              onClick={(e) => { e.stopPropagation(); onOpenAgent(assignee.id); }}
              title={`Open ${assignee.name} in the inspector`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 0 }}
            >
              <AgentAvatar name={assignee.name} accent={assignee.accent} />
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                color: 'var(--cth-ink-700)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>{assignee.name}</span>
            </span>
          ) : (
            <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
              color: 'var(--cth-ink-500)'
            }}>{task.assignee ? task.assignee : 'unassigned'}</span>
          )}
        </span>

        <span
          style={{ display: 'inline-flex', gap: 3, justifyContent: 'flex-end' }}
          title={rankable ? undefined : 'Pick a project to reorder its backlog — rank is per project'}
        >
          <MoveButton dir="up" disabled={!rankable || first || busy} onClick={() => onMove('up')} />
          <MoveButton dir="down" disabled={!rankable || last || busy} onClick={() => onMove('down')} />
        </span>
      </div>

      {expanded && (
        <TaskDetail task={task} agents={agents} busy={busy} onPatch={onPatch} />
      )}
    </div>
  );
}

function MoveButton({ dir, disabled, onClick }: { dir: 'up' | 'down'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={dir === 'up' ? 'Move up the backlog' : 'Move down the backlog'}
      style={{
        width: 20, height: 18, border: 'none', cursor: disabled ? 'default' : 'pointer',
        borderRadius: 'var(--cth-radius-xs)',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        color: disabled ? 'var(--cth-ink-300)' : 'var(--cth-ink-700)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 10, lineHeight: 1, padding: 0
      }}
    >{dir === 'up' ? '▲' : '▼'}</button>
  );
}

const CONTRACT_FIELDS: { key: keyof TaskContract; label: string; hint: string }[] = [
  { key: 'objective',  label: 'Objective',  hint: 'The concrete goal.' },
  { key: 'output',     label: 'Output',     hint: 'The expected deliverable or format.' },
  { key: 'tools',      label: 'Tools',      hint: 'What to use or avoid; what to read instead of re-deriving.' },
  { key: 'boundaries', label: 'Boundaries', hint: 'Scope limits and the definition of done.' }
];

function TaskDetail({
  task, agents, busy, onPatch
}: {
  task: ProjectTask;
  agents: { id: string; name: string }[];
  busy: boolean;
  onPatch: (p: Partial<ProjectTask>) => void;
}) {
  const [draft, setDraft] = useState<TaskContract>({
    objective: task.contract?.objective ?? '',
    output: task.contract?.output ?? '',
    tools: task.contract?.tools ?? '',
    boundaries: task.contract?.boundaries ?? ''
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify({
    objective: task.contract?.objective ?? '',
    output: task.contract?.output ?? '',
    tools: task.contract?.tools ?? '',
    boundaries: task.contract?.boundaries ?? ''
  });

  return (
    <div style={{
      padding: '10px 12px 12px', background: 'var(--cth-cream-200)',
      display: 'flex', flexDirection: 'column', gap: 10
    }}>
      {task.description && (
        <p style={{
          margin: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-ink-700)', lineHeight: 1.5
        }}>{task.description}</p>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Field label="Status">
          <select
            value={task.status}
            disabled={busy}
            onChange={(e) => onPatch({ status: e.target.value as ProjectTask['status'] })}
            style={selectStyle}
          >
            <option value="todo">todo</option>
            <option value="doing">doing</option>
            <option value="blocked">blocked</option>
            <option value="done">done</option>
          </select>
        </Field>
        <Field label="Assignee">
          <select
            value={task.assignee ?? ''}
            disabled={busy}
            onChange={(e) => onPatch({ assignee: e.target.value || undefined })}
            style={selectStyle}
          >
            <option value="">unassigned</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        {task.result && (
          <Field label="Result">
            <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
              color: 'var(--cth-ink-700)'
            }}>{task.result}</span>
          </Field>
        )}
      </div>

      <div>
        <div style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
          color: 'var(--cth-ink-500)', marginBottom: 6
        }}>Dispatch contract</div>
        <p style={{
          margin: '0 0 8px', fontFamily: 'var(--cth-font-ui)',
          fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)', lineHeight: 1.45
        }}>
          The four parts the orchestrator is already told to dispatch with. Filling
          them in here means the agent gets the same contract without you having to
          trust it was written well.
        </p>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
          {CONTRACT_FIELDS.map(({ key, label, hint }) => (
            <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
                textTransform: 'uppercase', letterSpacing: '0.1em',
                color: 'var(--cth-lemon)'
              }}>{label}</span>
              <textarea
                value={draft[key] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                placeholder={hint}
                rows={2}
                style={{
                  resize: 'vertical', padding: '6px 8px', width: '100%',
                  borderRadius: 'var(--cth-radius-sm)',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                  color: 'var(--cth-ink-900)', outline: 'none'
                }}
              />
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <PixelButton
            variant="primary"
            size="sm"
            disabled={busy || !dirty || !draft.objective.trim() || !draft.output.trim()}
            onClick={() => onPatch({
              contract: {
                objective: draft.objective.trim(),
                output: draft.output.trim(),
                ...(draft.tools?.trim() ? { tools: draft.tools.trim() } : {}),
                ...(draft.boundaries?.trim() ? { boundaries: draft.boundaries.trim() } : {})
              }
            })}
          >save contract</PixelButton>
          {!draft.objective.trim() || !draft.output.trim()
            ? <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
              color: 'var(--cth-ink-500)'
            }}>objective and output are the minimum</span>
            : null}
        </div>
      </div>

      {(task.humanQA ?? []).length > 0 && (
        <div>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            color: 'var(--cth-ink-500)', marginBottom: 6
          }}>Decision trail</div>
          {(task.humanQA ?? []).map((qa, i) => (
            <div key={i} style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
              color: 'var(--cth-ink-700)', lineHeight: 1.5, marginBottom: 4
            }}>
              <strong>asked:</strong> {qa.q}
              {qa.a ? <> · <strong>answered:</strong> {qa.a}</> : <span style={{ color: 'var(--cth-status-blocked)' }}> · open</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  borderRadius: 'var(--cth-radius-sm)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
  color: 'var(--cth-ink-900)'
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
        color: 'var(--cth-ink-500)'
      }}>{label}</span>
      {children}
    </span>
  );
}
