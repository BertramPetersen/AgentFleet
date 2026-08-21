/**
 * AssignmentEngine — the live actor around the pure rules in assignment.ts.
 *
 * Every tick it rebuilds fleet state from the hive (ledger, registry,
 * projects) plus a caller-supplied idle set, asks `decideAssignments` what to
 * do, and ACTS only on the dispatches:
 *
 *   - the card gets `assignee`, `status: 'doing'`, and a `dispatch` stamp
 *     (who routed it, which rule, when) — the stamp is the audit trail and the
 *     status flip is the idempotence: a doing card is no longer ready, so no
 *     rule ever fires on it twice;
 *   - the agent gets ONE inbox message carrying the card's contract verbatim;
 *   - the decision lands in log.jsonl (`kind: 'auto-assign'`) so future
 *     replays can see what the rules did, not just what the ledger became.
 *
 * Holds are deliberately not acted on OR logged per-tick — they recompute
 * every tick from the same state, so logging them would fill the log with a
 * steady-state truth the backlog already shows.
 *
 * Everything that needs judgment still belongs to the dispatcher agent; this
 * engine only ever does what a human could predict from the five rules.
 */

import { decideAssignments, type Decision, type RuleAgent, type RuleProject, type RuleTask } from './assignment';

interface HiveLike {
  enabled(): boolean;
  tasks(): unknown;
  patchTask(id: string, patch: Record<string, unknown>): boolean;
  send(partial: Record<string, unknown>, from?: string): unknown;
  registry(): { godId: string | null; agents: Record<string, RuleAgent & { archived?: boolean }> };
  appendLog(event: Record<string, unknown>): void;
}

interface ProjectsLike {
  list(): RuleProject[];
}

export interface AssignmentEngineDeps {
  hive: HiveLike;
  projects: ProjectsLike;
  /** Which agents are idle RIGHT NOW — computed by the caller from telemetry
   *  (recent usage) and inbox backlog. Idleness is an observation, not a rule. */
  idleAgents: () => Set<string>;
}

type LedgerTask = RuleTask & { dispatch?: { by?: string; to?: string } };

function parseLedger(raw: unknown): LedgerTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list.filter((t): t is LedgerTask =>
    !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string');
}

function dispatchBody(t: LedgerTask, rule: string): string {
  const c = t.contract ?? {};
  const contract = [
    `OBJECTIVE: ${c.objective ?? ''}`,
    `OUTPUT: ${c.output ?? ''}`,
    c.tools ? `TOOLS: ${c.tools}` : '',
    c.boundaries ? `BOUNDARIES: ${c.boundaries}` : ''
  ].filter(Boolean).join('\n');
  return [
    `You are assigned task ${t.id}${t.projectId ? ` in project ${t.projectId}` : ''}: "${t.title ?? t.id}".`,
    contract,
    'Work it now. When you finish, report the result to god (act: "inform") so the card is moved to done — include the task id.',
    `(Routed by the deterministic assignment rules: ${rule}.)`
  ].join('\n\n');
}

export class AssignmentEngine {
  constructor(private deps: AssignmentEngineDeps) {}

  /** One pass: decide, act on dispatches, return what was acted on. */
  tick(): Decision[] {
    const { hive, projects, idleAgents } = this.deps;
    if (!hive.enabled()) return [];

    let tasks: LedgerTask[];
    let agents: RuleAgent[];
    let projectList: RuleProject[];
    try {
      tasks = parseLedger(hive.tasks());
      const idle = idleAgents();
      agents = Object.values(hive.registry().agents ?? {}).map((a) => ({ ...a, idle: idle.has(a.id) }));
      projectList = projects.list();
    } catch {
      return []; // hive mid-write or unreadable — next tick will see a consistent state
    }

    const decisions = decideAssignments({ tasks, agents, projects: projectList });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const acted: Decision[] = [];

    for (const d of decisions) {
      if (d.action !== 'dispatch' || !d.assignee) continue;
      const t = byId.get(d.taskId);
      if (!t) continue;
      // Belt over the status-flip suspenders: never re-send a card that
      // already carries this dispatch stamp.
      if (t.dispatch?.to === d.assignee) continue;

      const ok = hive.patchTask(d.taskId, {
        assignee: d.assignee,
        status: 'doing',
        dispatch: { by: 'rules', rule: d.rule, to: d.assignee, at: new Date().toISOString() }
      });
      if (!ok) continue;

      try {
        hive.send({
          to: d.assignee,
          act: 'request',
          subject: `DISPATCH: ${t.title ?? t.id}`,
          body: dispatchBody(t, d.rule)
        }, 'system');
      } catch { /* message failed — the stamp stands, god sees the card is doing */ }

      hive.appendLog({ kind: 'auto-assign', taskId: d.taskId, to: d.assignee, rule: d.rule, reason: d.reason });
      acted.push(d);
    }

    return acted;
  }
}
