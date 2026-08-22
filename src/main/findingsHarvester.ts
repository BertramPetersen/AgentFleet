/**
 * Findings harvester (C3) — reviewer reports become card data, deterministically.
 *
 * The review contract tells compliance agents to report findings as a JSON
 * block plus an APPROVE / REQUEST_CHANGES verdict. Trusting an agent to also
 * patch the ledger is prompt-trust; this harvester removes it. It observes
 * every routed hive message, and when one comes FROM a compliance agent and
 * carries a findings block naming a review card, it writes `findings` and
 * `verdict` onto that card itself. God still executes the verdict (closing
 * cards is judgment-adjacent and stays in the prompt contract) — but what the
 * reviewer FOUND is now structured history the eval tool can score against
 * post-merge reality, whatever god does next.
 */

export interface ReviewFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  description: string;
  action?: string;
}

export interface HarvestedReport {
  reviewCardId: string;
  verdict?: 'APPROVE' | 'REQUEST_CHANGES';
  findings: ReviewFinding[];
}

const SEVERITIES = new Set(['error', 'warning', 'info']);

function coerceFinding(raw: unknown): ReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== 'string' || typeof f.description !== 'string') return null;
  return {
    id: f.id,
    severity: SEVERITIES.has(f.severity as string) ? (f.severity as ReviewFinding['severity']) : 'info',
    ...(typeof f.file === 'string' ? { file: f.file } : {}),
    ...(typeof f.line === 'number' && Number.isFinite(f.line) ? { line: f.line } : {}),
    description: f.description,
    ...(typeof f.action === 'string' ? { action: f.action } : {})
  };
}

/** Extract the report from a reviewer's message body: the review-card id, the
 *  verdict token, and every finding inside `{"findings":[…]}` blocks — found
 *  by brace-matching from each `"findings"` key, so surrounding prose and
 *  markdown fences never matter. Returns null when the body names no review
 *  card or carries neither findings nor a verdict. */
export function parseFindingsReport(text: string): HarvestedReport | null {
  const cardMatch = text.match(/\brev-[a-z0-9][a-z0-9-]*-\d+\b/i);
  if (!cardMatch) return null;

  const findings: ReviewFinding[] = [];
  const keyRe = /"findings"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(text)) !== null) {
    // Walk back to the opening brace of the object holding the key, then
    // brace-match forward to slice a parseable JSON object.
    let start = text.lastIndexOf('{', m.index);
    if (start < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { findings?: unknown };
      if (Array.isArray(obj.findings)) {
        for (const raw of obj.findings) {
          const f = coerceFinding(raw);
          if (f && !findings.some((x) => x.id === f.id)) findings.push(f);
        }
      }
    } catch { /* not a clean JSON block — keep scanning */ }
  }

  const verdict = /\bREQUEST_CHANGES\b/.test(text) ? 'REQUEST_CHANGES' as const
    : /\bAPPROVE[D]?\b/i.test(text) ? 'APPROVE' as const
      : undefined;

  if (findings.length === 0 && !verdict) return null;
  return { reviewCardId: cardMatch[0], ...(verdict ? { verdict } : {}), findings };
}

export interface HarvesterDeps {
  hive: {
    tasks(): unknown;
    patchTask(id: string, patch: Record<string, unknown>): boolean;
    appendLog(event: Record<string, unknown>): void;
  };
  /** Is this sender a compliance agent? (registry role/capability check) */
  isComplianceAgent: (agentId: string) => boolean;
}

export class FindingsHarvester {
  constructor(private deps: HarvesterDeps) {}

  /** Chained into the hive's routed-message observer. Never throws. */
  onRouted(msg: { from?: string; subject?: string; body?: string }): void {
    try {
      const from = msg.from ?? '';
      if (!from || !this.deps.isComplianceAgent(from)) return;
      const report = parseFindingsReport(`${msg.subject ?? ''}\n${msg.body ?? ''}`);
      if (!report) return;
      const ledger = this.deps.hive.tasks() as { tasks?: { id: string }[] };
      const exists = Array.isArray(ledger?.tasks) && ledger.tasks.some((t) => t?.id === report.reviewCardId);
      if (!exists) return;
      const ok = this.deps.hive.patchTask(report.reviewCardId, {
        ...(report.findings.length ? { findings: report.findings } : {}),
        ...(report.verdict ? { verdict: report.verdict } : {}),
        reviewedBy: from,
        reviewedAt: new Date().toISOString()
      });
      if (ok) {
        this.deps.hive.appendLog({
          kind: 'review-harvested',
          taskId: report.reviewCardId,
          from,
          verdict: report.verdict ?? null,
          findings: report.findings.length
        });
      }
    } catch { /* observation must never break routing */ }
  }
}
