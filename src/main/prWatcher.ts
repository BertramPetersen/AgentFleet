/**
 * PR watcher — the Compliance Department's intake (decision D2).
 *
 * The handoff point is PR creation: when an author agent opens a PR, a
 * compliance agent takes the review over and the author returns to the hive.
 * This watcher makes that deterministic. Every tick, per live project, it
 * asks `gh` for the repo's open PRs and for each new one:
 *
 *   1. creates a REVIEW CARD — `labels: ['compliance']`, so the P6 rules
 *      route it fleet-wide to an idle compliance-capable agent; the card's
 *      contract tells the reviewer exactly how to work (gh pr diff, findings
 *      in the no-mistakes schema, verdict semantics);
 *   2. RELEASES THE AUTHOR — the work card whose assignee's worktree is on
 *      the PR's head branch flips to status 'review' (not done: the verdict
 *      closes it; not doing: a review-status card no longer busies its
 *      assignee, so the rules can hand the author its next card).
 *
 * Identity is `rev-<projectId>-<pr number>` — re-ticks and app restarts are
 * idempotent because addTask is idempotent by id. Drafts are skipped (the
 * author is still working). `gh` failures are silent per-project: a repo
 * without a GitHub remote simply never produces review cards.
 */

import { execFile } from 'node:child_process';
import type { RuleProject, RuleTask } from './assignment';

export interface OpenPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
}

interface ReviewTask {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'blocked' | 'review' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
}

export interface PrWatcherDeps {
  hive: {
    enabled(): boolean;
    tasks(): unknown;
    // Structural subsets of HiveManager's real signatures — the watcher only
    // needs the ledger fields it writes, and staying structural keeps the
    // engine file untouched (same pattern as ProjectStore).
    addTask(task: ReviewTask): boolean;
    patchTask(id: string, patch: { status: ReviewTask['status'] }): boolean;
    appendLog(event: Record<string, unknown>): void;
    registry(): { agents: Record<string, { id: string; cwd?: string; archived?: boolean }> };
  };
  projects: { list(): (RuleProject & { repoPath?: string; archived?: boolean })[] };
  /** List a repo's open PRs — injectable so the selftest can drive the watcher
   *  without a network. The default runs `gh pr list` with cwd = repoPath. */
  listOpenPrs?: (repoPath: string) => Promise<OpenPr[]>;
  /** Current git branch of a directory — used to match a PR's head branch to
   *  the author agent's worktree. Injectable for the selftest. */
  branchOf?: (dir: string) => Promise<string | null>;
}

/** The repo gh should query — ALWAYS pinned explicitly from the project's
 *  `origin` remote. Left to its own resolution, gh prefers an `upstream`
 *  remote when one exists, and a fork's watcher would ingest the upstream's
 *  entire community PR queue (observed live: 30+ foreign review cards). */
function originRepoSlug(repoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { timeout: 10_000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const m = stdout.trim().match(/github\.com[:/]([^/]+\/[^/.\s]+)(?:\.git)?$/);
        resolve(m ? m[1] : null);
      });
  });
}

async function ghListOpenPrs(repoPath: string): Promise<OpenPr[]> {
  const slug = await originRepoSlug(repoPath);
  if (!slug) return [];
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--json', 'number,title,url,headRefName,isDraft', '--limit', '50'],
      { cwd: repoPath, timeout: 20_000 },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const rows = JSON.parse(stdout) as OpenPr[];
          resolve(Array.isArray(rows) ? rows : []);
        } catch { resolve([]); }
      });
  });
}

function gitBranchOf(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'branch', '--show-current'], { timeout: 10_000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

export function reviewCardId(projectId: string, prNumber: number): string {
  return `rev-${projectId}-${prNumber}`;
}

function reviewContract(pr: OpenPr, projectId: string): Record<string, string> {
  return {
    objective: `Review PR #${pr.number} ("${pr.title}") in project ${projectId}: ${pr.url}. Judge it against the work card's dispatch contract (find it in tasks.json by the branch ${pr.headRefName}) and against how the human likes code written (the repo's CLAUDE.md/AGENTS.md conventions).`,
    output: 'A verdict plus findings. Findings use exactly this JSON shape, posted in your report: {"findings":[{"id":"<slug>","severity":"error|warning|info","file":"<path>","line":<n>,"description":"<what and why>","action":"fix|discuss|note"}]}. Verdict is APPROVE or REQUEST_CHANGES with the findings that block.',
    tools: `Read the diff with \`gh pr diff ${pr.url}\` and the description with \`gh pr view ${pr.url}\`. Do not check out or modify anything — you review, you do not fix.`,
    boundaries: `You own the verdict, not the merge. On APPROVE: report to god that PR #${pr.number} is approved — god sets this review card AND the work card on branch ${pr.headRefName} to done. On REQUEST_CHANGES: report the blocking findings to god so the work card returns to its author with them. Never mark cards done yourself; never merge.`
  };
}

export class PrWatcher {
  private listOpen: (repoPath: string) => Promise<OpenPr[]>;
  private branch: (dir: string) => Promise<string | null>;
  private ticking = false;

  constructor(private deps: PrWatcherDeps) {
    this.listOpen = deps.listOpenPrs ?? ghListOpenPrs;
    this.branch = deps.branchOf ?? gitBranchOf;
  }

  /** One pass over every live project. Returns the review-card ids created. */
  async tick(): Promise<string[]> {
    const { hive, projects } = this.deps;
    if (!hive.enabled() || this.ticking) return [];
    this.ticking = true;
    const created: string[] = [];
    try {
      const ledger = hive.tasks() as { tasks?: RuleTask[] };
      const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
      const byId = new Set(tasks.map((t) => t.id));
      const live = projects.list().filter((p) => !p.archived && p.repoPath);

      for (const project of live) {
        let prs: OpenPr[] = [];
        try { prs = await this.listOpen(project.repoPath as string); } catch { continue; }
        for (const pr of prs) {
          if (pr.isDraft) continue;
          const id = reviewCardId(project.id, pr.number);
          if (byId.has(id)) continue;

          const card = {
            id,
            title: `Review PR #${pr.number} — ${pr.title}`,
            status: 'todo' as const,
            dependsOn: [],
            priority: 1, // reviews outrank new feature pulls at equal rank
            createdAt: new Date().toISOString(),
            projectId: project.id,
            labels: ['compliance'],
            contract: reviewContract(pr, project.id),
            review: { url: pr.url, number: pr.number, headRef: pr.headRefName }
          };
          // The extra fields (projectId/labels/contract/review) round-trip
          // through the ledger untouched, exactly like P3's fields do.
          const ok = hive.addTask(card as unknown as ReviewTask);
          if (!ok) continue;
          created.push(id);
          hive.appendLog({ kind: 'pr-review-card', projectId: project.id, pr: pr.number, url: pr.url, taskId: id });

          await this.releaseAuthor(project, pr, tasks);
        }
      }
    } finally {
      this.ticking = false;
    }
    return created;
  }

  /** D2's second half: the author goes back to the hive. The work card whose
   *  assignee's worktree sits on the PR's head branch flips to 'review' —
   *  review-status cards neither busy their assignee nor count as ready. */
  private async releaseAuthor(
    project: RuleProject & { repoPath?: string },
    pr: OpenPr,
    tasks: RuleTask[]
  ): Promise<void> {
    const { hive } = this.deps;
    const doing = tasks.filter((t) => t.status === 'doing' && t.assignee && t.projectId === project.id);
    if (doing.length === 0) return;
    const agents = hive.registry().agents;
    for (const card of doing) {
      const agent = agents[card.assignee as string];
      if (!agent?.cwd) continue;
      let branch: string | null = null;
      try { branch = await this.branch(agent.cwd); } catch { /* no repo there */ }
      if (branch && branch === pr.headRefName) {
        hive.patchTask(card.id, { status: 'review' });
        hive.appendLog({ kind: 'pr-handoff', taskId: card.id, agentId: agent.id, pr: pr.number });
        return; // one work card per PR head
      }
    }
  }
}
