/**
 * ProjectStore — projects as a first-class thing, on disk in the hive.
 *
 * Before this, "project" was a renderer-only display string set to
 * `basename(cwd)`. It never reached the hive, so nothing could group work: the
 * task ledger had an assignee but no idea which codebase a card belonged to.
 *
 * Projects live in `<hive>/projects.json` and follow the same rules as the rest
 * of the hive: only the main process writes, writes are atomic, and every change
 * is committed by the single committer (HiveManager.commit) so the audit trail
 * stays intact. Agents can read the file like any other hive file.
 *
 * The task side needs NO engine change. `HiveManager.patchTask` already merges
 * with `{ ...existing, ...patch }` and its own comment promises to preserve
 * unrelated fields, so `projectId`, `rank`, `labels` and `contract` round-trip
 * through the ledger untouched. Old ledgers keep parsing because every added
 * field is optional.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mainRepoRoot } from './git';

export type ProjectIsolation = 'shared' | 'worktree-per-agent';

export interface Project {
  /** Stable slug, used as the foreign key on a task. */
  id: string;
  name: string;
  /** Absolute path agents in this project run in. */
  repoPath: string;
  isolation: ProjectIsolation;
  /** Agent ids assigned to this project. */
  members: string[];
  /** Optional spend ceiling for the project rollup. Advisory in P3. */
  budgetUsd?: number;
  archived?: boolean;
  createdAt: string;
}

/** The task shape this module cares about — the four fields P3 adds, plus the
 *  ledger fields it reads. Deliberately not imported from hive.ts: this module
 *  only ever widens a task, and staying structural keeps the engine file
 *  untouched. */
export interface ProjectTaskFields {
  id: string;
  assignee?: string;
  status?: string;
  priority?: number;
  createdAt?: string;
  projectId?: string;
  /** Zero-padded ordinal. Lexicographic so a plain string sort is the backlog
   *  order, and rewritten as a block on reorder — see `reorder`. */
  rank?: string;
  labels?: string[];
  /** The dispatch contract the orchestrator's prompt already asks for, stored
   *  structurally so it can be reviewed and edited before dispatch. */
  contract?: {
    objective: string;
    output: string;
    tools?: string;
    boundaries?: string;
  };
}

/** The slice of HiveManager this store needs. Keeps it unit-testable and makes
 *  the dependency explicit rather than importing the whole manager. */
export interface HiveAccess {
  root(): string | null;
  ensureHive(): void;
  commit(message: string): void;
  tasks(): unknown;
  writeTasks(tasks: never[]): void;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RANK_WIDTH = 6;

export function rankFor(index: number): string {
  return String(index + 1).padStart(RANK_WIDTH, '0');
}

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38);
  return SLUG_RE.test(base) ? base : `proj-${randomBytes(3).toString('hex')}`;
}

export function validateProject(p: unknown): { ok: true; project: Project } | { ok: false; error: string } {
  if (!p || typeof p !== 'object') return { ok: false, error: 'not an object' };
  const r = p as Partial<Project>;
  if (typeof r.id !== 'string' || !SLUG_RE.test(r.id)) return { ok: false, error: 'id must be a lowercase slug' };
  if (typeof r.name !== 'string' || !r.name.trim()) return { ok: false, error: 'name is required' };
  if (typeof r.repoPath !== 'string' || !isAbsolute(r.repoPath)) {
    return { ok: false, error: 'repoPath must be an absolute path' };
  }
  const isolation: ProjectIsolation = r.isolation === 'worktree-per-agent' ? 'worktree-per-agent' : 'shared';
  return {
    ok: true,
    project: {
      id: r.id,
      name: r.name.trim(),
      repoPath: r.repoPath,
      isolation,
      members: Array.isArray(r.members) ? r.members.filter((m): m is string => typeof m === 'string') : [],
      ...(typeof r.budgetUsd === 'number' && r.budgetUsd > 0 ? { budgetUsd: r.budgetUsd } : {}),
      ...(r.archived ? { archived: true } : {}),
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString()
    }
  };
}

/** One agent, as much as the seeder needs. */
export interface SeedAgent {
  id: string;
  cwd: string;
  isGod?: boolean;
  isAssistant?: boolean;
  archived?: boolean;
}

export class ProjectStore {
  constructor(private readonly hive: HiveAccess) {}

  private file(): string | null {
    const root = this.hive.root();
    return root ? join(root, 'projects.json') : null;
  }

  list(): Project[] {
    const path = this.file();
    if (!path || !existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { projects?: unknown };
      if (!Array.isArray(raw?.projects)) return [];
      return raw.projects
        .map((p) => validateProject(p))
        .filter((r): r is { ok: true; project: Project } => r.ok)
        .map((r) => r.project);
    } catch {
      return [];
    }
  }

  private write(projects: Project[]): void {
    const path = this.file();
    if (!path) return;
    this.hive.ensureHive();
    const tmp = `${path}.tmp-${randomBytes(3).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify({ projects }, null, 2), 'utf8');
    renameSync(tmp, path);
    this.hive.commit(`hive: projects (${projects.length})`);
  }

  upsert(input: unknown): { ok: true; project: Project } | { ok: false; error: string } {
    const validated = validateProject(input);
    if (!validated.ok) return validated;
    const projects = this.list();
    const index = projects.findIndex((p) => p.id === validated.project.id);
    // Preserve createdAt on update — the caller round-trips a project it read,
    // but a hand-built patch should not silently reset the project's birthday.
    const next = index < 0
      ? [...projects, validated.project]
      : projects.map((p, i) => (i === index ? { ...validated.project, createdAt: p.createdAt } : p));
    this.write(next);
    return { ok: true, project: validated.project };
  }

  setArchived(id: string, archived: boolean): boolean {
    const projects = this.list();
    if (!projects.some((p) => p.id === id)) return false;
    this.write(projects.map((p) => (p.id === id ? { ...p, archived } : p)));
    return true;
  }

  private readTasks(): ProjectTaskFields[] {
    const ledger = this.hive.tasks() as { tasks?: unknown };
    return Array.isArray(ledger?.tasks) ? (ledger.tasks as ProjectTaskFields[]).filter(Boolean) : [];
  }

  private writeTasks(tasks: ProjectTaskFields[]): void {
    this.hive.writeTasks(tasks as unknown as never[]);
  }

  /**
   * One-pass backfill, idempotent.
   *
   * Creates a project per distinct worker REPO (worktrees collapse into the
   * repo they belong to), stamps every task with the
   * project of its assignee, and gives the backlog an initial order from the
   * fields that already existed (priority, then age). Runs only when there are
   * no projects yet, so it never fights a human's later edits.
   *
   * The orchestrator and its assistant are deliberately excluded: their cwd is
   * the hive itself, which is not a project, and their cards belong in Intake
   * until someone files them.
   */
  async seedIfEmpty(agents: SeedAgent[]): Promise<{ seeded: boolean; projects: number; tasksStamped: number }> {
    if (!this.hive.root()) return { seeded: false, projects: 0, tasksStamped: 0 };
    if (this.list().length > 0) return { seeded: false, projects: 0, tasksStamped: 0 };

    const workers = agents.filter((a) => !a.isGod && !a.isAssistant && a.cwd && isAbsolute(a.cwd));
    // A project is a REPO, not a directory. Grouping by raw cwd gave every
    // worktree-isolated agent its own phantom project named after the agent —
    // and since membership matches on path prefix, that agent then belonged to
    // two projects at once. `git rev-parse --git-common-dir` resolves a worktree
    // to the repo it belongs to, which is convention-independent (no guessing at
    // a `.worktrees/` segment) and correct for nested checkouts too.
    const byPath = new Map<string, SeedAgent[]>();
    const isWorktree = new Map<string, boolean>();
    for (const a of workers) {
      const root = (await mainRepoRoot(a.cwd).catch(() => null)) ?? a.cwd;
      const list = byPath.get(root) ?? [];
      list.push(a);
      byPath.set(root, list);
      if (root !== a.cwd) isWorktree.set(root, true);
    }

    const used = new Set<string>();
    const projects: Project[] = [];
    const projectOfAgent = new Map<string, string>();
    for (const [repoPath, members] of byPath) {
      const name = basename(repoPath) || repoPath;
      let id = slugify(name);
      while (used.has(id)) id = `${id}-${randomBytes(2).toString('hex')}`;
      used.add(id);
      projects.push({
        id,
        name,
        repoPath,
        // A member already running in a worktree of this repo is the honest
        // signal that the project is set up isolated.
        isolation: isWorktree.get(repoPath) ? 'worktree-per-agent' : 'shared',
        members: members.map((m) => m.id),
        createdAt: new Date().toISOString()
      });
      for (const m of members) projectOfAgent.set(m.id, id);
    }

    if (projects.length > 0) this.write(projects);

    const tasks = this.readTasks();
    let stamped = 0;
    const ordered = tasks
      .slice()
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
        || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    const next = tasks.map((t) => {
      const projectId = t.projectId ?? (t.assignee ? projectOfAgent.get(t.assignee) : undefined);
      const rank = t.rank ?? rankFor(ordered.findIndex((o) => o.id === t.id));
      if (projectId && projectId !== t.projectId) stamped++;
      return { ...t, ...(projectId ? { projectId } : {}), rank };
    });
    if (tasks.length > 0) this.writeTasks(next);

    return { seeded: true, projects: projects.length, tasksStamped: stamped };
  }

  /**
   * Move one card within its project's backlog and renumber the block.
   *
   * Ranks are rewritten wholesale rather than fractionally interpolated. A
   * fractional index avoids touching siblings, but it needs midpoint-string
   * maths and a rebalance path when keys collide; renumbering a single
   * project's cards is one write and obviously correct. Revisit if a project
   * ever holds enough cards for that write to hurt.
   */
  reorder(taskId: string, direction: 'up' | 'down'): boolean {
    const tasks = this.readTasks();
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return false;

    const siblings = tasks
      .filter((t) => (t.projectId ?? null) === (target.projectId ?? null))
      .sort((a, b) => String(a.rank ?? '').localeCompare(String(b.rank ?? '')));
    const at = siblings.findIndex((t) => t.id === taskId);
    const to = direction === 'up' ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= siblings.length) return false;

    const moved = siblings.slice();
    [moved[at], moved[to]] = [moved[to], moved[at]];
    const rankById = new Map(moved.map((t, i) => [t.id, rankFor(i)]));
    this.writeTasks(tasks.map((t) => (rankById.has(t.id) ? { ...t, rank: rankById.get(t.id) } : t)));
    return true;
  }
}
