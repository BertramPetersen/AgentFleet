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

export function parseTasks(raw: unknown): ProjectTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: ProjectTask[] }).tasks
    : [];
  return list.filter((t): t is ProjectTask => !!t && typeof t === 'object' && typeof t.id === 'string');
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
