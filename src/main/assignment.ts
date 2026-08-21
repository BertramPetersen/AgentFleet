/**
 * Deterministic assignment rules — the "predictable" half of hybrid assignment.
 *
 * Routing a ready card to an idle project member is mechanical, and mechanical
 * decisions made by a ~600-word prompt are untestable. This module is the
 * testable half: a PURE function from fleet state to decisions, no I/O, no
 * clock, so the replay harness (tools/replay-assignment.mjs) can run it over a
 * recorded hive and the live tick can run it over the real one — same code,
 * same answers.
 *
 * The dispatcher agent keeps everything that needs judgment: decomposing a
 * vague ask into cards, triage, cross-agent conflict resolution, what to
 * escalate to the human, and sign-off. Rules run first; the agent handles what
 * falls through — every `hold` decision below is exactly that fall-through,
 * with the reason stated so the dispatcher (and the human) can see why.
 *
 * The five rules, from the plan of record (.lavish/fork-plan.html):
 *   1. An explicit assignee you set is honored.
 *   2. Capability/role match against the registry.
 *   3. Pull the top-ranked ready card when a project member goes idle.
 *   4. Never route outside a project's members.
 *   5. Refuse a card with no contract.
 */

export interface RuleTask {
  id: string;
  title?: string;
  status?: string;
  assignee?: string;
  dependsOn?: string[];
  priority?: number;
  createdAt?: string;
  projectId?: string;
  rank?: string;
  labels?: string[];
  contract?: { objective?: string; output?: string; tools?: string; boundaries?: string };
}

export interface RuleAgent {
  id: string;
  name?: string;
  role?: string;
  capabilities?: string[];
  cwd?: string;
  isGod?: boolean;
  isAssistant?: boolean;
  archived?: boolean;
  /** Computed by the CALLER: the live tick derives it from telemetry
   *  (lastActiveSecAgo + no inbox backlog), the replay harness from its own
   *  heuristic. The rules only consume it — idleness is an observation, not a
   *  rule. */
  idle?: boolean;
}

export interface RuleProject {
  id: string;
  repoPath?: string;
  members?: string[];
  archived?: boolean;
}

export interface FleetState {
  tasks: RuleTask[];
  agents: RuleAgent[];
  projects: RuleProject[];
}

export type RuleId =
  | 'explicit-assignee'   // rule 1 — dispatch to the assignee already on the card
  | 'idle-pull'           // rule 3 (+2) — top-ranked ready card to an idle member
  | 'no-contract'         // rule 5 — held until objective+output exist
  | 'not-a-member'        // rule 4 — the named assignee is outside the project
  | 'assignee-unavailable'// rule 1 — assignee is archived/gone
  | 'unfiled'             // no projectId — decomposition/filing is dispatcher work
  | 'no-idle-member';     // ready and contracted, but nobody is free

export interface Decision {
  taskId: string;
  action: 'dispatch' | 'hold';
  /** Set when action is 'dispatch'. */
  assignee?: string;
  rule: RuleId;
  reason: string;
}

/** A contract is dispatchable when its two mandatory parts exist — the same
 *  minimum the backlog editor enforces ("objective and output are the minimum"). */
export function hasContract(t: RuleTask): boolean {
  return !!t.contract
    && typeof t.contract.objective === 'string' && t.contract.objective.trim() !== ''
    && typeof t.contract.output === 'string' && t.contract.output.trim() !== '';
}

/** Backlog order: rank when present, then priority, then age — the exact
 *  comparator the renderer sorts the board with, so "top-ranked" here is the
 *  card the human sees at the top. */
export function backlogOrder(a: RuleTask, b: RuleTask): number {
  const ra = a.rank ?? '';
  const rb = b.rank ?? '';
  if (ra && rb && ra !== rb) return ra.localeCompare(rb);
  if (ra && !rb) return -1;
  if (!ra && rb) return 1;
  return (b.priority ?? 0) - (a.priority ?? 0)
    || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    || a.id.localeCompare(b.id);
}

/** Membership mirrors the renderer's agentsInProject: cwd is the primary
 *  signal (it decides which codebase the agent actually edits, and a
 *  worktree-isolated agent runs in a subdirectory), the members list is
 *  honoured for hand-assigned agents. */
export function isMember(agent: RuleAgent, project: RuleProject): boolean {
  const repo = project.repoPath ?? '';
  return (!!repo && (agent.cwd === repo || (agent.cwd ?? '').startsWith(`${repo}/`)))
    || (project.members ?? []).includes(agent.id);
}

/** Ready = todo with every dependency done. A dependency id that does not
 *  exist in the ledger counts as done — a deleted card must not freeze its
 *  dependents forever. */
function isReady(t: RuleTask, byId: Map<string, RuleTask>): boolean {
  if ((t.status ?? 'todo') !== 'todo') return false;
  for (const dep of t.dependsOn ?? []) {
    const d = byId.get(dep);
    if (d && d.status !== 'done') return false;
  }
  return true;
}

/** Rule 2 — capability/role match. A card's labels are matched against the
 *  agent's declared capabilities and its role string. No labels = any member
 *  qualifies; labels narrow the field but never widen it past the project. */
function capable(agent: RuleAgent, t: RuleTask): boolean {
  const labels = (t.labels ?? []).map((l) => l.toLowerCase()).filter(Boolean);
  if (labels.length === 0) return true;
  const haystack = [
    ...(agent.capabilities ?? []),
    agent.role ?? '',
    agent.name ?? ''
  ].join(' ').toLowerCase();
  return labels.some((l) => haystack.includes(l));
}

function eligible(a: RuleAgent): boolean {
  return !a.archived && !a.isGod && !a.isAssistant;
}

/**
 * One pass over the ledger. Deterministic: same state in, same decisions out —
 * agents are considered in id order, cards in backlog order, and each agent
 * takes at most ONE card per pass (a dispatch is a real message to a real
 * agent; flooding an idle agent's inbox with the whole backlog helps nobody).
 */
export function decideAssignments(state: FleetState): Decision[] {
  const decisions: Decision[] = [];
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const projects = new Map(state.projects.filter((p) => !p.archived).map((p) => [p.id, p]));
  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  const busied = new Set<string>(
    // An agent already holding a doing/blocked card is not free for a pull.
    state.tasks
      .filter((t) => (t.status === 'doing' || t.status === 'blocked') && t.assignee)
      .map((t) => t.assignee as string)
  );

  const ready = state.tasks.filter((t) => isReady(t, byId)).sort(backlogOrder);

  for (const t of ready) {
    // Rule 1 — an explicit assignee is the human's (or dispatcher's) call.
    if (t.assignee) {
      const a = agents.find((x) => x.id === t.assignee || x.name === t.assignee);
      if (!a || a.archived) {
        decisions.push({ taskId: t.id, action: 'hold', rule: 'assignee-unavailable', reason: `assignee "${t.assignee}" is not on the fleet` });
        continue;
      }
      const p = t.projectId ? projects.get(t.projectId) : undefined;
      // Rule 4 — even an explicit assignee never crosses a project boundary.
      if (p && !isMember(a, p) && !a.isGod) {
        decisions.push({ taskId: t.id, action: 'hold', rule: 'not-a-member', reason: `"${a.id}" is not a member of ${p.id}` });
        continue;
      }
      // Rule 5 applies to rule-driven dispatch too: a card with no contract is
      // not ready to leave, whoever's name is on it.
      if (!hasContract(t)) {
        decisions.push({ taskId: t.id, action: 'hold', rule: 'no-contract', reason: 'no dispatch contract (objective + output are the minimum)' });
        continue;
      }
      decisions.push({ taskId: t.id, action: 'dispatch', assignee: a.id, rule: 'explicit-assignee', reason: `explicit assignee ${a.id}` });
      busied.add(a.id);
      continue;
    }

    // Unassigned card: rules only pull it for an idle member of its project.
    if (!t.projectId || !projects.has(t.projectId)) {
      decisions.push({ taskId: t.id, action: 'hold', rule: 'unfiled', reason: 'no project — filing/decomposition is dispatcher work' });
      continue;
    }
    if (!hasContract(t)) {
      decisions.push({ taskId: t.id, action: 'hold', rule: 'no-contract', reason: 'no dispatch contract (objective + output are the minimum)' });
      continue;
    }
    const p = projects.get(t.projectId) as RuleProject;
    const members = agents.filter((a) => eligible(a) && isMember(a, p));
    if (members.length === 0) {
      decisions.push({ taskId: t.id, action: 'hold', rule: 'no-idle-member', reason: `${p.id} has no eligible members` });
      continue;
    }
    // Rule 3 — pull by the first idle, capable, un-busied member.
    const idle = members.find((a) => a.idle && !busied.has(a.id) && capable(a, t));
    if (!idle) {
      decisions.push({ taskId: t.id, action: 'hold', rule: 'no-idle-member', reason: `no idle ${t.labels?.length ? `"${t.labels.join('/')}"-capable ` : ''}member free in ${p.id}` });
      continue;
    }
    decisions.push({ taskId: t.id, action: 'dispatch', assignee: idle.id, rule: 'idle-pull', reason: `top-ranked ready card in ${p.id} → idle member ${idle.id}` });
    busied.add(idle.id);
  }

  return decisions;
}
