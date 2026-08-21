import type { Agent } from './store';

/**
 * Renderer-side mirror of the project shapes.
 *
 * LOCKSTEP with src/main/projects.ts and the `Project` interface in
 * src/preload/index.ts. The renderer's tsconfig does not include the preload
 * project, so shapes are re-declared here rather than imported — the same
 * local-redeclare pattern useTelemetry.ts uses for the telemetry contract. If a
 * field moves there, move it here.
 */

export type ProjectIsolation = 'shared' | 'worktree-per-agent';

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  isolation: ProjectIsolation;
  members: string[];
  budgetUsd?: number;
  archived?: boolean;
  createdAt: string;
}

/** The dispatch contract the orchestrator's prompt already asks for, stored on
 *  the card so it can be read and edited before the work goes out. */
export interface TaskContract {
  objective: string;
  output: string;
  tools?: string;
  boundaries?: string;
}

/** The hive task ledger, widened by the four optional fields P3 adds. They
 *  round-trip through HiveManager.patchTask untouched, so no engine change was
 *  needed to store them. */
export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  humanQA?: { q: string; a?: string; askedAt?: string; answeredAt?: string; dismissedAt?: string }[];
  result?: string;
  projectId?: string;
  rank?: string;
  labels?: string[];
  contract?: TaskContract;
}

const STATUSES: ProjectTask['status'][] = ['todo', 'doing', 'blocked', 'done'];

/**
 * Parse AND normalize. tasks.json is not exclusively ours: the orchestrator
 * edits it directly on disk, and a hand-written card carries only the fields
 * its author thought of. Every view renders whatever this returns, so missing
 * fields are made safe HERE — a card without `dependsOn` once unmounted the
 * whole app from a single `.length` in a row renderer.
 */
export function parseTasks(raw: unknown): ProjectTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list
    .filter((t): t is Record<string, unknown> =>
      !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string')
    .map((t) => ({
      ...(t as unknown as ProjectTask),
      id: t.id as string,
      title: typeof t.title === 'string' ? t.title : String(t.id),
      status: STATUSES.includes(t.status as ProjectTask['status']) ? (t.status as ProjectTask['status']) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' && Number.isFinite(t.priority) ? t.priority : 0,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : '',
      humanQA: Array.isArray(t.humanQA)
        ? (t.humanQA as unknown[]).filter((q): q is NonNullable<ProjectTask['humanQA']>[number] =>
            !!q && typeof q === 'object' && typeof (q as { q?: unknown }).q === 'string')
        : undefined,
      labels: Array.isArray(t.labels) ? (t.labels as unknown[]).filter((l): l is string => typeof l === 'string') : undefined
    }));
}

/**
 * Which agents belong to a project.
 *
 * `cwd` is the primary signal, not `members`: an agent's working directory is
 * set at spawn and is the thing that actually decides which codebase it edits,
 * whereas a members list is a copy that goes stale the moment an agent is
 * respawned elsewhere. A worktree-isolated agent runs in a subdirectory of the
 * repo, so a prefix match catches it too. `members` is still honoured for agents
 * someone assigned by hand.
 */
export function agentsInProject(agents: Agent[], project: Project): Agent[] {
  return agents.filter((a) =>
    a.cwd === project.repoPath
    || a.cwd?.startsWith(`${project.repoPath}/`)
    || project.members.includes(a.id));
}

export function projectOfAgent(projects: Project[], agent: Agent): Project | undefined {
  return projects.find((p) =>
    agent.cwd === p.repoPath
    || agent.cwd?.startsWith(`${p.repoPath}/`)
    || p.members.includes(agent.id));
}

/** Backlog order: rank when present, then priority, then age. Cards written
 *  before P3 have no rank, so they sort by the fields that already existed
 *  instead of jumping to the top. */
export function backlogOrder(a: ProjectTask, b: ProjectTask): number {
  const ra = a.rank ?? '';
  const rb = b.rank ?? '';
  if (ra && rb && ra !== rb) return ra.localeCompare(rb);
  if (ra && !rb) return -1;
  if (!ra && rb) return 1;
  return (b.priority ?? 0) - (a.priority ?? 0)
    || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
}
