import { useCallback, useEffect, useRef, useState } from 'react';
import { openQuestion, waitsOnHuman, type HiveTask } from '@/components/TasksKanban';
import { parseTasks, type ProjectTask } from '@/store/projects';

/**
 * The one implementation of "the human owes this card an answer".
 *
 * Answering is two writes that must both happen, and getting either wrong is
 * quiet data loss: the answer is recorded ON the card (so the decision trail
 * lives with the work it unblocked, forever) AND mailed to the orchestrator (so
 * it actually unblocks the card and the work continues). Dismissing marks the
 * entry `dismissedAt` rather than inventing an answer, so the question survives
 * in the history even though it leaves the queue.
 *
 * This was implemented once inside AskMeTab. P4 gives the same queue a
 * full-width home, and two copies of a two-write flow is the kind of duplication
 * that drifts into one of them forgetting to mail the god. So it lives here and
 * both views consume it.
 */

const POLL_MS = 5000;

/**
 * Asks already announced, keyed by card + when it was asked.
 *
 * MODULE scope on purpose. "Notify once per ask, however many views are open" is
 * a property of the app, not of a component: the queue can be mounted in the
 * main area and in the Command Center at the same time, and per-instance state
 * would announce the same question twice. Re-asking the same card appends a new
 * humanQA entry with a new askedAt, so a genuine re-ask still gets through.
 *
 * A notification is fired by whichever view notices first. This lives in the
 * renderer rather than main because the orchestrator writes tasks.json directly
 * on disk — main never sees the write, so it has nothing to react to.
 */
const announced = new Set<string>();
let notifyEnabled: boolean | null = null;

function askKey(taskId: string, askedAt?: string): string {
  return `${taskId}@${askedAt ?? ''}`;
}

function announce(asks: { task: { id: string; title: string }; question: string; askedAt?: string }[]): void {
  for (const ask of asks) {
    const key = askKey(ask.task.id, ask.askedAt);
    if (announced.has(key)) continue;
    // Record every key even when we will not fire, so an ask is announced at
    // most once whatever the reason we skipped it.
    announced.add(key);
    // The first poll after launch is a backlog, not news.
    if (!firstPollDone) continue;
    // Unknown (null) means the config read has not landed yet. Stay quiet rather
    // than risk notifying against the user's setting.
    if (notifyEnabled !== true) continue;
    try {
      if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
      new Notification('An agent needs you', {
        body: `${ask.task.title}\n${ask.question}`,
        tag: key
      });
    } catch { /* notifications unavailable — the queue still shows it */ }
  }
}

let firstPollDone = false;

export interface HumanAsk {
  task: ProjectTask;
  /** The unanswered, undismissed question. */
  question: string;
  askedAt?: string;
  /** Open cards that cannot move until this one does, transitively. */
  frozen: ProjectTask[];
}

/** Everything transitively waiting on `id`, cycle-safe. */
function dependentsTree(id: string, all: ProjectTask[], seen = new Set<string>()): ProjectTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done');
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}

export interface UseHumanAsks {
  tasks: ProjectTask[];
  asks: HumanAsk[];
  /** Set while a write for that task id is in flight. */
  sending: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  answer: (taskId: string, text: string) => Promise<boolean>;
  dismiss: (taskId: string) => Promise<boolean>;
}

/** @param projectId scope to one project, or null/undefined for every project. */
export function useHumanAsks(projectId?: string | null): UseHumanAsks {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* keep the last good list */ }
  }, []);

  // One config read for the whole app, cached at module scope: the flag is the
  // same native-notification switch the breaker and hook toasts already respect.
  useEffect(() => {
    if (notifyEnabled !== null) return;
    window.cth.getConfig?.()
      .then((c) => { notifyEnabled = !!(c as { notifications?: boolean }).notifications; })
      .catch(() => { notifyEnabled = false; });
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const scoped = projectId ? tasks.filter((t) => t.projectId === projectId) : tasks;
  const asks: HumanAsk[] = scoped
    .filter((t) => waitsOnHuman(t as unknown as HiveTask))
    .map((task) => {
      const open = openQuestion(task as unknown as HiveTask);
      return {
        task,
        question: open?.q ?? '',
        askedAt: open?.askedAt,
        // The cascade is computed against EVERY task, not the scoped list: work
        // in another project can genuinely be stuck behind this answer, and
        // hiding that would understate the cost of not answering.
        frozen: dependentsTree(task.id, tasks)
      };
    })
    .sort((a, b) => String(a.askedAt ?? '').localeCompare(String(b.askedAt ?? '')));

  /** Stamp the open entry on one card, then persist just the humanQA array. */
  const patchOpenEntry = async (
    taskId: string,
    stamp: (entry: NonNullable<ProjectTask['humanQA']>[number]) => NonNullable<ProjectTask['humanQA']>[number]
  ): Promise<{ ok: boolean; next: ProjectTask[] }> => {
    const task = tasks.find((t) => t.id === taskId);
    const open = task ? openQuestion(task as unknown as HiveTask) : undefined;
    if (!task || !open) return { ok: false, next: tasks };
    const next = tasks.map((t) => {
      if (t.id !== taskId) return t;
      const qa = (t.humanQA ?? []).map((e) =>
        // Identity first, then a value match: the array was re-parsed from disk
        // by the poll, so the object the caller saw may no longer be the same
        // reference as the one in this list.
        (e === open || (e.q === open.q && !e.a && !e.dismissedAt)) ? stamp(e) : e
      );
      return { ...t, humanQA: qa };
    });
    const updated = next.find((t) => t.id === taskId);
    const res = updated
      ? await window.cth.hivePatchTask(taskId, { humanQA: updated.humanQA } as Parameters<typeof window.cth.hivePatchTask>[1])
      : { ok: false as const };
    return { ok: !!res.ok, next };
  };

  const answer = async (taskId: string, text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body || sending) return false;
    const task = tasks.find((t) => t.id === taskId);
    const open = task ? openQuestion(task as unknown as HiveTask) : undefined;
    if (!task || !open) return false;
    setSending(taskId);
    setError(null);
    try {
      const stamped = await patchOpenEntry(taskId, (e) => ({
        ...e, a: body, answeredAt: new Date().toISOString()
      }));
      if (!stamped.ok) throw new Error('the card changed before the answer could be saved');
      setTasks(stamped.next);
      // Recording the answer is not the same as unblocking the work: the
      // orchestrator has to read it and move the card. If this send fails the
      // answer is still on the card, so say so rather than pretending it landed.
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `HUMAN ANSWER on task "${task.title}"`,
        body: [
          `The human answered the open question on task ${task.id} ("${task.title}"):`,
          `Q: ${open.q}`,
          `A: ${body}`,
          "The answer is also recorded in the card's humanQA. Act on it, unblock the card, and continue the work."
        ].join('\n')
      }, 'human');
      // The explicit learning loop (C2): an answer on a COMPLIANCE review card
      // is feedback on how the human wants work judged — it also lands in the
      // preference ledger. Best-effort: the answer itself already succeeded,
      // and the Needs-you card says out loud that this recording happens.
      if ((task.labels ?? []).some((l) => l.toLowerCase() === 'compliance')) {
        window.cth.complianceRecordAnswer?.({
          taskId: task.id, question: open.q, answer: body, projectId: task.projectId
        }).catch(() => { /* ledger write failed — the answer still landed */ });
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the answer could not be delivered');
      return false;
    } finally {
      setSending(null);
    }
  };

  const dismiss = async (taskId: string): Promise<boolean> => {
    if (sending) return false;
    setSending(taskId);
    setError(null);
    const before = tasks;
    try {
      const stamped = await patchOpenEntry(taskId, (e) => ({
        ...e, dismissedAt: new Date().toISOString()
      }));
      setTasks(stamped.next); // optimistic — the card should leave the queue at once
      if (!stamped.ok) throw new Error('the card changed before the ask could be dismissed');
      return true;
    } catch (e) {
      setTasks(before);
      setError(e instanceof Error ? e.message : 'the ask could not be dismissed');
      return false;
    } finally {
      setSending(null);
    }
  };

  useEffect(() => {
    // Deliberately NOT gated on tasks.length: an empty first poll still has to
    // mark the backlog as seen, or the first ask ever raised would be treated as
    // pre-existing and silently swallowed.
    // Announce from every project, not the scoped view: which project you happen
    // to be looking at must not decide whether you hear about a blocked one.
    const all = tasks
      .filter((t) => waitsOnHuman(t as unknown as HiveTask))
      .map((task) => {
        const open = openQuestion(task as unknown as HiveTask);
        return { task, question: open?.q ?? '', askedAt: open?.askedAt };
      });
    announce(all);
    firstPollDone = true;
  }, [tasks]);

  return { tasks, asks, sending, error, refresh, answer, dismiss };
}
