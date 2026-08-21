import { useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { useStore } from '@/store/store';
import { useHumanAsks } from '@/hooks/useHumanAsks';

/**
 * ASK ME — the Command Center's copy of the human-ask queue.
 *
 * The polling, the two-write answer flow and the frozen-dependents walk moved to
 * useHumanAsks in P4, when this queue also got a full-width home in
 * NeedsYouInbox. Two views, one implementation: the flow writes the answer onto
 * the card AND mails the orchestrator, and a second copy of that would sooner or
 * later forget the second write.
 *
 * This view keeps its own narrow-column layout and its link into the task detail
 * overlay, which the full-width inbox does not need.
 */

export function AskMeTab() {
  // One instance: each call to the hook starts its own poll loop.
  const { asks, sending, error, answer, dismiss } = useHumanAsks();
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  // Drafts live in the STORE (keyed by task id) — switching tabs unmounts this
  // view, and a half-typed answer must survive the round trip.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  const send = async (taskId: string): Promise<void> => {
    const ok = await answer(taskId, drafts[taskId] ?? '');
    if (ok) setAnswerDraft(taskId, '');
  };

  return (
    // Body text is set in the mono face (VT323) — the same readable font the
    // memory viewer uses. Pixelify Sans (font-ui) is too chunky for prose like
    // questions and answers. Display/badge bits keep their explicit faces.
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      {error && (
        <div style={{ padding: '4px 8px', background: 'var(--cth-coral-light)', fontSize: 12, color: 'var(--cth-ink-900)' }}>
          {error}
        </div>
      )}
      {asks.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          Nothing needs you right now. 🌿<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            When the team blocks a task on your input — a question to answer or a to-do only
            you can perform — it shows up here (and on the ASK ME board on the floor).
          </span>
        </div>
      )}
      {asks.map(({ task: t, question, frozen: stuck }) => {
        return (
          <div key={t.id} style={{
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            display: 'flex', flexDirection: 'column'
          }}>
            {/* header: title + assignee */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
              background: 'var(--cth-lilac-light, #ece2f5)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)'
            }}>
              <button
                onClick={() => openTaskDetail(t.id)}
                title="open the full task detail"
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 15, color: 'var(--cth-ink-900)',
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}
              >
                {t.title}
              </button>
              {nameFor(t.assignee) && <PixelBadge status="blocked" label={nameFor(t.assignee)!} />}
              {/* Dismiss — clears this ask off the board without answering it.
                  The card's Q&A history is preserved (the question stays on the
                  card, just marked dismissed). */}
              <button
                onClick={() => void dismiss(t.id)}
                disabled={sending === t.id}
                title="dismiss — clear this off the ASK ME board without answering (history kept)"
                aria-label="dismiss this ask"
                style={{
                  flexShrink: 0, width: 18, height: 18, padding: 0, marginLeft: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                  border: 'none', cursor: sending === t.id ? 'default' : 'pointer',
                  background: 'transparent', color: 'var(--cth-ink-500)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13
                }}
                onMouseEnter={(e) => { if (sending !== t.id) e.currentTarget.style.color = 'var(--cth-coral)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
              >✕</button>
            </div>

            <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* the question */}
              <div style={{ fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap' }}>
                {question}
              </div>

              {/* answer box */}
              <textarea
                value={drafts[t.id] ?? ''}
                onChange={(e) => setAnswerDraft(t.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(t.id); }}
                rows={3}
                placeholder="Your answer — or 'done', with the result… (Ctrl+Enter to send)"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 15, lineHeight: '18px',
                  color: 'var(--cth-ink-900)', outline: 'none'
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <PixelButton
                  variant="primary" size="sm"
                  disabled={!(drafts[t.id] ?? '').trim() || sending === t.id}
                  onClick={() => void send(t.id)}
                >
                  {sending === t.id ? 'sending…' : 'respond & unblock'}
                </PixelButton>
                {(t.humanQA?.filter((e) => e.a).length ?? 0) > 0 && (
                  <button
                    onClick={() => openTaskDetail(t.id)}
                    title="open the task detail with the full Q&A history"
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                      fontSize: 10, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)',
                      textDecoration: 'underline'
                    }}
                  >
                    VIEW {t.humanQA!.filter((e) => e.a).length} EARLIER ANSWER{t.humanQA!.filter((e) => e.a).length === 1 ? '' : 'S'}
                  </button>
                )}
              </div>

              {/* the cascade: what's stuck behind this answer */}
              {stuck.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-coral)' }}>
                    BLOCKING {stuck.length} DOWNSTREAM TASK{stuck.length === 1 ? '' : 'S'}
                  </div>
                  {stuck.slice(0, 6).map((d, i) => (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      paddingLeft: 8 + Math.min(i, 3) * 8,
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ color: 'var(--cth-ink-300)' }}>└</span>
                      <span style={{ width: 7, height: 7, flexShrink: 0, background: d.status === 'blocked' ? 'var(--cth-coral)' : 'var(--cth-sky)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                      {nameFor(d.assignee) && <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>({nameFor(d.assignee)})</span>}
                    </div>
                  ))}
                  {stuck.length > 6 && (
                    <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--cth-ink-300)' }}>… +{stuck.length - 6} more</div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
