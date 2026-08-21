import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { agentsInProject, parseTasks, type Project, type ProjectTask } from '@/store/projects';
import { Icon } from './Icon';

/**
 * The workspace rail: which project am I looking at, and which view of it.
 *
 * Projects are the organising unit the product was missing — before this,
 * `project` was a display string set to `basename(cwd)` that never left the
 * renderer. Selecting one scopes the fleet and the backlog to the agents whose
 * working directory sits in that repo.
 *
 * "All projects" stays first and is the default. The fleet is still the thing
 * you want on a fresh launch, and forcing a project choice before showing any
 * work would be a worse first screen than the one we replaced.
 */

const POLL_MS = 8000;

export function ProjectRail() {
  const agents = useStore((s) => s.agents);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const mainView = useStore((s) => s.mainView);
  const setMainView = useStore((s) => s.setMainView);
  const { samples } = useFleetTelemetry();

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  // Durable per-project spend from the cost ledger — the same number the
  // over-budget dispatch rule reads, so what the rail shows is what the rules
  // enforce. (The fleet's per-agent $ stays session telemetry; a project's $ is
  // a budget question and budgets survive restarts.)
  const [spend, setSpend] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      window.cth.projectsList?.().then((list) => { if (alive) setProjects(list ?? []); }).catch(() => { /* hive off */ });
      window.cth.hiveTasks?.().then((raw) => { if (alive) setTasks(parseTasks(raw)); }).catch(() => { /* hive off */ });
      window.cth.projectsSpend?.().then((m) => { if (alive) setSpend(m ?? {}); }).catch(() => { /* hive off */ });
    };
    read();
    const t = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const live = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  const openTasks = useMemo(() => tasks.filter((t) => t.status !== 'done'), [tasks]);
  const needingHuman = useMemo(
    () => tasks.filter((t) => t.status === 'blocked' && (t.humanQA ?? []).some((q) => !q.a && !q.dismissedAt)).length,
    [tasks]
  );

  const stats = (p: Project | null): { agents: number; open: number; usd: number } => {
    if (!p) {
      return {
        agents: live.length,
        open: openTasks.length,
        usd: live.reduce((sum, a) => sum + (samples[a.id]?.usd ?? 0), 0)
      };
    }
    const members = agentsInProject(live, p);
    const ids = new Set(members.map((a) => a.id));
    return {
      agents: members.length,
      open: openTasks.filter((t) => t.projectId === p.id).length,
      usd: members.reduce((sum, a) => sum + (samples[a.id]?.usd ?? 0), 0)
    };
  };

  const visible = projects.filter((p) => !p.archived);
  const intake = openTasks.filter((t) => !t.projectId).length;

  return (
    <div style={{
      width: 208, flex: '0 0 208px', minHeight: 0, overflowY: 'auto',
      background: 'var(--cth-cream-200)',
      borderRight: '1px solid var(--cth-ink-100)',
      display: 'flex', flexDirection: 'column', padding: '10px 8px', gap: 2
    }}>
      <RailHead>Workspace</RailHead>
      <RailItem
        icon="mcp"
        label="Fleet"
        count={stats(projects.find((p) => p.id === activeProjectId) ?? null).agents}
        on={mainView === 'fleet'}
        onClick={() => setMainView('fleet')}
      />
      <RailItem
        icon="check"
        label="Backlog"
        count={stats(projects.find((p) => p.id === activeProjectId) ?? null).open}
        on={mainView === 'backlog'}
        onClick={() => setMainView('backlog')}
      />
      {/* Always present, even at zero: it is a place you navigate to, and hiding
          it when the queue empties makes it feel like it moved. */}
      <RailItem
        icon="bell"
        label="Needs you"
        count={needingHuman}
        alert={needingHuman > 0}
        on={mainView === 'needs'}
        onClick={() => setMainView('needs')}
      />

      <RailHead>Projects</RailHead>
      <RailItem
        label="All projects"
        dot="var(--cth-ink-300)"
        count={stats(null).agents}
        on={activeProjectId === null}
        onClick={() => setActiveProject(null)}
        sub={stats(null).usd > 0 ? `$${stats(null).usd.toFixed(2)}` : undefined}
      />
      {visible.map((p, i) => {
        const s = stats(p);
        const usd = spend[p.id] ?? 0;
        const over = !!p.budgetUsd && p.budgetUsd > 0 && usd >= p.budgetUsd;
        return (
          <RailItem
            key={p.id}
            label={p.name}
            title={`${p.repoPath}${p.isolation === 'worktree-per-agent' ? ' · worktree per agent' : ''}${p.budgetUsd ? ` · $${usd.toFixed(2)} of $${p.budgetUsd.toFixed(2)} budget${over ? ' — over, dispatch paused' : ''}` : ''}`}
            dot={`var(--cth-${DOT_ACCENTS[i % DOT_ACCENTS.length]})`}
            count={s.agents}
            on={activeProjectId === p.id}
            onClick={() => setActiveProject(p.id)}
            sub={usd > 0 ? `$${usd.toFixed(2)}` : undefined}
            subAlert={over}
          />
        );
      })}
      {visible.length === 0 && (
        <p style={{
          margin: '4px 8px', fontFamily: 'var(--cth-font-ui)',
          fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)', lineHeight: 1.45
        }}>
          No projects yet. One is derived per working directory the moment you
          spawn an agent outside the hive.
        </p>
      )}

      {intake > 0 && (
        <>
          <RailHead>Unfiled</RailHead>
          <RailItem
            icon="ledger"
            label="Intake"
            count={intake}
            on={false}
            onClick={() => { setActiveProject(null); setMainView('backlog'); }}
            title="Open cards with no project — usually the orchestrator's own work"
          />
        </>
      )}
    </div>
  );
}

const DOT_ACCENTS = ['lemon', 'sky', 'lilac', 'mint', 'peach', 'coral'] as const;

function RailHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--cth-font-display)',
      fontSize: 'var(--cth-text-display-sm)',
      textTransform: 'uppercase', letterSpacing: '0.12em',
      color: 'var(--cth-ink-500)', padding: '10px 8px 5px'
    }}>{children}</div>
  );
}

function RailItem({
  label, count, on, onClick, icon, dot, sub, alert, subAlert, title
}: {
  label: string;
  count?: number;
  on: boolean;
  onClick: () => void;
  icon?: Parameters<typeof Icon>[0]['name'];
  dot?: string;
  sub?: string;
  alert?: boolean;
  /** Paint the sub (the $ figure) in the blocked tone — over budget. */
  subAlert?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '6px 8px', border: 'none', cursor: 'pointer', textAlign: 'left',
        borderRadius: 'var(--cth-radius-sm)',
        background: on ? 'var(--cth-paper-200)' : 'transparent',
        fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
        color: on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'
      }}
    >
      {dot
        ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flex: '0 0 7px' }} />
        : icon ? <Icon name={icon} /> : null}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {sub && (
        <span style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
          color: subAlert ? 'var(--cth-status-blocked)' : 'var(--cth-ink-500)'
        }}>{sub}</span>
      )}
      {count !== undefined && (
        <span style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
          fontVariantNumeric: 'tabular-nums',
          color: alert ? 'var(--cth-status-blocked)' : 'var(--cth-ink-500)'
        }}>{count}</span>
      )}
    </button>
  );
}
