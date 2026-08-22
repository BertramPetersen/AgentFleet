import { useState } from 'react';
import { useStore } from '@/store/store';
import { useHumanAsks, type HumanAsk } from '@/hooks/useHumanAsks';
import { PixelButton } from './PixelButton';
import { AgentAvatar } from './AgentAvatar';

/**
 * NEEDS YOU — the only queue that should ever interrupt you.
 *
 * An agent that can only proceed with a human sets its card to blocked and
 * appends the ask to the card's humanQA. That already worked; what it lacked was
 * the COST of not answering. A question on its own reads as optional. The same
 * question with "4 cards frozen behind this, oldest waiting 2h" reads as the
 * bottleneck it actually is, which is the whole reason to give this a screen
 * rather than a tab.
 *
 * Two ways to clear an ask, because not every ask is a question: answer it, or —
 * when it was a to-do only you could do — say you did it. Dismissing is neither:
 * it takes the ask off the queue without inventing an answer, and the question
 * stays on the card so the trail is never lost.
 */

function agoLabel(iso?: string): { text: string; urgent: boolean } {
  if (!iso) return { text: 'just now', urgent: false };
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { text: 'just now', urgent: false };
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return { text: 'just now', urgent: false };
  if (mins < 60) return { text: `${mins}m`, urgent: false };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { text: `${hours}h ${mins % 60}m`, urgent: hours >= 1 };
  return { text: `${Math.floor(hours / 24)}d`, urgent: true };
}

export function NeedsYouInbox() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const agents = useStore((s) => s.agents);
  const openInspector = useStore((s) => s.openInspector);
  const { asks, sending, error, answer, dismiss } = useHumanAsks(activeProjectId);

  return (
    <div style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)', boxShadow: 'var(--cth-panel-border)'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        borderBottom: '1px solid var(--cth-ink-100)'
      }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)'
        }}>Needs you</span>
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: asks.length ? 'var(--cth-status-blocked)' : 'var(--cth-ink-500)'
        }}>
          {asks.length === 0 ? 'nothing waiting' : `${asks.length} waiting`}
        </span>
      </div>

      {error && (
        <div style={{
          padding: '5px 12px', background: 'var(--cth-status-blocked-bg)',
          borderBottom: '1px solid var(--cth-status-blocked-bd)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-status-blocked)'
        }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {asks.length === 0 && (
          <div style={{
            padding: '32px 16px', textAlign: 'center',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)'
          }}>
            <div style={{ fontSize: 'var(--cth-text-body-md)', marginBottom: 6 }}>
              Nothing needs you right now.
            </div>
            <div style={{ fontSize: 'var(--cth-text-body-sm)', maxWidth: 420, margin: '0 auto', lineHeight: 1.5 }}>
              When an agent blocks a card on your input — a question to answer, or a
              to-do only you can perform — it arrives here with whatever work is
              stuck behind it.
            </div>
          </div>
        )}

        {asks.map((ask) => (
          <AskCard
            key={ask.task.id}
            ask={ask}
            agentName={agents.find((a) => a.id === ask.task.assignee)?.name}
            agentAccent={agents.find((a) => a.id === ask.task.assignee)?.accent}
            busy={sending === ask.task.id}
            onAnswer={(text) => answer(ask.task.id, text)}
            onDismiss={() => dismiss(ask.task.id)}
            onOpenAgent={ask.task.assignee ? () => openInspector(ask.task.assignee as string) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function AskCard({
  ask, agentName, agentAccent, busy, onAnswer, onDismiss, onOpenAgent
}: {
  ask: HumanAsk;
  agentName?: string;
  agentAccent?: Parameters<typeof AgentAvatar>[0]['accent'];
  busy: boolean;
  onAnswer: (text: string) => Promise<boolean>;
  onDismiss: () => void;
  onOpenAgent?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const age = agoLabel(ask.askedAt);

  const send = async (text: string): Promise<void> => {
    const ok = await onAnswer(text);
    if (ok) setDraft('');
  };

  return (
    <div style={{
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
      borderRadius: 'var(--cth-radius-md)',
      overflow: 'hidden',
      background: 'var(--cth-cream-100)'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px',
        background: 'var(--cth-paper-100)', borderBottom: '1px solid var(--cth-ink-100)',
        flexWrap: 'wrap'
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 8px',
          borderRadius: 'var(--cth-radius-pill)',
          background: age.urgent ? 'var(--cth-status-blocked-bg)' : 'var(--cth-status-idle-bg)',
          boxShadow: `inset 0 0 0 1px ${age.urgent ? 'var(--cth-status-blocked-bd)' : 'var(--cth-status-idle-bd)'}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)', fontWeight: 600,
          color: age.urgent ? 'var(--cth-status-blocked)' : 'var(--cth-ink-700)'
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flex: '0 0 6px' }} />
          waiting {age.text}
        </span>
        <span style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
          color: 'var(--cth-ink-500)'
        }}>{ask.task.id.slice(-6)}</span>
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-md)',
          color: 'var(--cth-ink-900)', minWidth: 0, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>{ask.task.title}</span>
        {ask.task.projectId && (
          <span style={{
            padding: '1px 6px', fontFamily: 'var(--cth-font-mono)',
            fontSize: 'var(--cth-text-mono-sm)', color: 'var(--cth-ink-700)',
            borderRadius: 'var(--cth-radius-xs)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>{ask.task.projectId}</span>
        )}
        {agentName && (
          <span
            onClick={onOpenAgent}
            title={onOpenAgent ? `Open ${agentName} in the inspector` : agentName}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: onOpenAgent ? 'pointer' : 'default' }}
          >
            <AgentAvatar name={agentName} accent={agentAccent} />
            <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
              color: 'var(--cth-ink-700)'
            }}>{agentName}</span>
          </span>
        )}
      </div>

      <div style={{ padding: '11px 12px' }}>
        <p style={{
          margin: '0 0 10px', fontFamily: 'var(--cth-font-ui)',
          fontSize: 'var(--cth-text-body-lg)', lineHeight: 1.5, color: 'var(--cth-ink-900)'
        }}>“{ask.question}”</p>

        {(ask.task.labels ?? []).some((l) => l.toLowerCase() === 'compliance') && (
          <p style={{
            margin: '0 0 8px', fontFamily: 'var(--cth-font-ui)',
            fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)'
          }}>
            This is a review card — your answer is also recorded to the house
            preference ledger, so future reviews apply it.
          </p>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(draft); }}
          rows={3}
          placeholder="Answer it, or describe what you did…"
          style={{
            width: '100%', resize: 'vertical', padding: '7px 9px',
            borderRadius: 'var(--cth-radius-sm)',
            background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-md)',
            color: 'var(--cth-ink-900)', outline: 'none'
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <PixelButton variant="primary" size="sm" disabled={busy || !draft.trim()} onClick={() => void send(draft)}>
            send &amp; unblock
          </PixelButton>
          <PixelButton
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void send(draft.trim() || 'Done — I handled this outside the app.')}
          >
            <span title="For an ask that was a to-do rather than a question: records that you did it and tells the agent to continue.">
              I did it
            </span>
          </PixelButton>
          <PixelButton variant="secondary" size="sm" disabled={busy} onClick={onDismiss}>
            <span title="Take this off the queue without answering. The question stays on the card and the card stays blocked.">
              dismiss
            </span>
          </PixelButton>
          {busy && (
            <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
              color: 'var(--cth-ink-500)'
            }}>saving…</span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            {ask.frozen.length > 0 && (
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                color: 'var(--cth-status-blocked)'
              }}>
                {ask.frozen.length} {ask.frozen.length === 1 ? 'card' : 'cards'} frozen behind this
              </span>
            )}
          </span>
        </div>

        {ask.frozen.length > 0 && (
          <div style={{
            marginTop: 10, paddingTop: 9, borderTop: '1px dashed var(--cth-ink-100)'
          }}>
            <div style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
              textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--cth-ink-500)', marginBottom: 5
            }}>Waiting on this answer</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px' }}>
              {ask.frozen.map((t) => (
                <span key={t.id} style={{
                  fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                  color: 'var(--cth-ink-700)'
                }}>
                  ↳ <span style={{
                    fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
                    color: 'var(--cth-ink-500)'
                  }}>{t.id.slice(-6)}</span> {t.title}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
