/**
 * Correction miner (C3) — the implicit learning loop's deterministic trigger.
 *
 * When the human hand-edits files an agent's MERGED PR touched, that edit is
 * feedback nobody wrote down. The miner detects exactly that — commits by the
 * repo's configured human author, after the merge, touching the merged PR's
 * files — and turns it into a compliance card whose contract says: analyze
 * the correction, and if it reflects a durable preference, PROPOSE it to the
 * human via a humanQA ask. Nothing is auto-learned: the proposal lands in
 * Needs-you, and only the human's answer enters the ledger (through the same
 * C2 capture every review-card answer uses — one write path, no new trust).
 *
 * Judgment stays with the agent (is this correction a preference or a
 * one-off?); this module only detects, deduplicates, and dispatches. Each
 * merged review card is mined once (a `mined` stamp), so ticks and restarts
 * are idempotent.
 */

import { execFile } from 'node:child_process';
import type { RuleProject, RuleTask } from './assignment';

interface MinableCard extends RuleTask {
  review?: { url?: string; number?: number; headRef?: string };
  mined?: { at: string; commits: string[] };
}

export interface MergedPrInfo {
  state: string;
  mergedAt?: string | null;
  files: string[];
}

export interface CorrectionMinerDeps {
  hive: {
    enabled(): boolean;
    tasks(): unknown;
    addTask(task: RuleTask): boolean;
    patchTask(id: string, patch: Record<string, unknown>): boolean;
    appendLog(event: Record<string, unknown>): void;
  };
  projects: { list(): (RuleProject & { repoPath?: string; archived?: boolean })[] };
  /** `gh pr view <url> --json state,mergedAt,files` — injectable for tests. */
  prInfo?: (repoPath: string, url: string) => Promise<MergedPrInfo | null>;
  /** Human commits after `sinceIso` touching `paths`: [sha, ...] — injectable. */
  humanCommits?: (repoPath: string, sinceIso: string, paths: string[]) => Promise<string[]>;
}

function ghPrInfo(repoPath: string, url: string): Promise<MergedPrInfo | null> {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', url, '--json', 'state,mergedAt,files'], { cwd: repoPath, timeout: 20_000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const raw = JSON.parse(stdout) as { state?: string; mergedAt?: string; files?: { path?: string }[] };
          resolve({
            state: raw.state ?? '',
            mergedAt: raw.mergedAt ?? null,
            files: (raw.files ?? []).map((f) => f.path).filter((p): p is string => typeof p === 'string')
          });
        } catch { resolve(null); }
      });
  });
}

/** Commits by the repo's own configured author (the human at this machine),
 *  after the merge, touching the PR's files. Agent commits carry agent
 *  identities or Co-Authored-By trailers; the git author configured in the
 *  repo is the person whose corrections we mine. */
function gitHumanCommits(repoPath: string, sinceIso: string, paths: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, 'config', 'user.email'], { timeout: 10_000 }, (err, email) => {
      const author = err ? '' : email.trim();
      if (!author) { resolve([]); return; }
      execFile('git', [
        '-C', repoPath, 'log', `--since=${sinceIso}`, `--author=${author}`,
        '--no-merges', '--format=%H', '--', ...paths.slice(0, 100)
      ], { timeout: 20_000 }, (err2, stdout) => {
        resolve(err2 ? [] : stdout.trim().split('\n').filter(Boolean));
      });
    });
  });
}

export function mineCardId(reviewCardId: string): string {
  return `mine-${reviewCardId}`;
}

function mineContract(card: MinableCard, commits: string[], repoPath: string): Record<string, string> {
  const pr = card.review?.url ?? 'the reviewed PR';
  return {
    objective: `The human hand-edited files that ${pr} touched, AFTER it merged — commits ${commits.slice(0, 5).join(', ')} in ${repoPath}. Analyze what the human changed relative to the merged work and decide whether the correction reflects a DURABLE preference about how they like code written, or a one-off.`,
    output: `If it reflects a preference: set THIS card's status to blocked and append to its humanQA a proposal ask, phrased exactly as the rule to learn — e.g. {"q":"Proposed preference: <one-sentence rule>. Answer with the rule to learn it (edit freely), or dismiss."}. The human's answer is recorded to the preference ledger automatically. If it is a one-off: report to god that there is no signal so this card is closed with that result.`,
    tools: `Read-only: \`git -C ${repoPath} show <sha>\` for each correction commit and \`gh pr diff ${pr}\` for what was merged. Do not modify anything.`,
    boundaries: 'Propose at most ONE rule per card — the strongest signal. Never write the ledger yourself; the proposal-answer path is the only entry. Judgment on one-off vs preference is yours; learning is the human’s.'
  };
}

export class CorrectionMiner {
  private prInfo: (repoPath: string, url: string) => Promise<MergedPrInfo | null>;
  private humanCommits: (repoPath: string, sinceIso: string, paths: string[]) => Promise<string[]>;
  private ticking = false;

  constructor(private deps: CorrectionMinerDeps) {
    this.prInfo = deps.prInfo ?? ghPrInfo;
    this.humanCommits = deps.humanCommits ?? gitHumanCommits;
  }

  /** One pass over merged, unmined review cards. Returns mine-card ids created. */
  async tick(): Promise<string[]> {
    const { hive, projects } = this.deps;
    if (!hive.enabled() || this.ticking) return [];
    this.ticking = true;
    const created: string[] = [];
    try {
      const ledger = hive.tasks() as { tasks?: MinableCard[] };
      const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
      const byId = new Set(tasks.map((t) => t.id));
      const projectById = new Map(projects.list().filter((p) => !p.archived && p.repoPath).map((p) => [p.id, p]));

      const candidates = tasks.filter((t) =>
        t.id.startsWith('rev-') && !t.mined && t.review?.url && t.projectId && projectById.has(t.projectId));

      for (const card of candidates) {
        const project = projectById.get(card.projectId as string) as RuleProject & { repoPath: string };
        const info = await this.prInfo(project.repoPath, card.review?.url as string);
        if (!info || info.state !== 'MERGED' || !info.mergedAt || info.files.length === 0) continue;

        const commits = await this.humanCommits(project.repoPath, info.mergedAt, info.files);
        if (commits.length === 0) {
          // Merged and untouched by the human so far — check again next tick;
          // no stamp, because the correction may land days later.
          continue;
        }

        const mineId = mineCardId(card.id);
        if (!byId.has(mineId)) {
          const ok = hive.addTask({
            id: mineId,
            title: `Mine correction — the human edited what ${card.title} approved`,
            status: 'todo',
            dependsOn: [],
            priority: 0,
            createdAt: new Date().toISOString(),
            projectId: card.projectId,
            labels: ['compliance'],
            contract: mineContract(card, commits, project.repoPath)
          } as unknown as RuleTask);
          if (ok) {
            created.push(mineId);
            hive.appendLog({ kind: 'correction-mine', reviewCardId: card.id, taskId: mineId, commits: commits.slice(0, 5) });
          }
        }
        hive.patchTask(card.id, { mined: { at: new Date().toISOString(), commits: commits.slice(0, 10) } });
      }
    } finally {
      this.ticking = false;
    }
    return created;
  }
}
