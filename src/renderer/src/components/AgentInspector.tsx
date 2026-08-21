import { useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { useFleetTelemetry, totalTokens } from '@/hooks/useTelemetry';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { AgentAvatar } from './AgentAvatar';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { ToolWaterfall } from './ToolWaterfall';
import { InterveneRail } from './InterveneRail';
import { GitTab } from './GitTab';
import { ThreadsPanel } from './ThreadsPanel';
import { Icon } from './Icon';
import { usePtyParser } from '@/hooks/usePtyParser';

/**
 * INSPECTOR — one agent, at full width.
 *
 * The same information used to live in a ~380px sidebar, where a tool timeline
 * and a terminal could not be read at the same time and the control levers were
 * a single cramped strip. Watching an agent and helping it are one task, so this
 * is one screen: what it has been doing (timeline), what it is saying now
 * (terminal), what it changed (diff), and what you can do about it (rail).
 *
 * Composition, not reimplementation — ToolWaterfall, PtyTerminalView,
 * MessageQueueComposer, GitTab and ThreadsPanel are the existing components,
 * given room.
 */

type Pane = 'activity' | 'changes' | 'messages';

const PANES: { key: Pane; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'activity', label: 'activity', icon: 'sparkle' },
  { key: 'changes',  label: 'changes',  icon: 'code' },
  { key: 'messages', label: 'messages', icon: 'bell' }
];

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function AgentInspector({ agent }: { agent: Agent }) {
  const closeInspector = useStore((s) => s.closeInspector);
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const setIdeOpen = useStore((s) => s.setIdeOpen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const { samples } = useFleetTelemetry();
  const onPtyStream = usePtyParser(agent.id);
  const [pane, setPane] = useState<Pane>('activity');

  const live = !!agent.ptyId;
  const sample = samples[agent.id];
  const ctx = agent.contextTokens ?? 0;
  const limit = agent.contextLimit ?? 0;
  const pct = limit > 0 ? Math.min(1, ctx / limit) : 0;
  const ctxColor = pct >= 0.85 ? 'var(--cth-status-blocked)'
    : pct >= 0.7 ? 'var(--cth-status-looping)'
      : 'var(--cth-status-success)';
  // Fullscreen owns the pty while it is up (it sizes the terminal to the window);
  // two mounted xterms fight over cols/rows and corrupt the display.
  const ptyIsElsewhere = fullscreenAgentId === agent.id;

  return (
    <div style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)', boxShadow: 'var(--cth-panel-border)'
    }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        borderBottom: '1px solid var(--cth-ink-100)', flexWrap: 'wrap'
      }}>
        <PixelButton variant="secondary" size="sm" onClick={closeInspector}>
          <span title="Back to the fleet" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            ← fleet
          </span>
        </PixelButton>
        <AgentAvatar name={agent.name} accent={agent.accent} />
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)'
        }}>{agent.name}{agent.isGod ? ' · boss' : ''}</span>
        <PixelBadge status={agent.status} />
        <Chip>{agent.provider ?? 'claude'}{agent.model ? ` · ${agent.model}` : ''}</Chip>
        <Chip>{agent.project}</Chip>
        {agent.worktreePath && <Chip>agent/{agent.id} worktree</Chip>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <PixelButton variant="secondary" size="sm" onClick={() => setIdeOpen(true, agent.id)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="code" /> IDE</span>
          </PixelButton>
          {live && (
            <PixelButton variant="secondary" size="sm" onClick={() => setFullscreen(agent.id)}>
              <span title="Full-window terminal" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="terminal" /> fullscreen
              </span>
            </PixelButton>
          )}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* main column: what it did, and what it is saying */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div role="tablist" style={{
            display: 'flex', gap: 4, padding: '6px 12px 0',
            borderBottom: '1px solid var(--cth-ink-100)'
          }}>
            {PANES.map((p) => (
              <button
                key={p.key}
                role="tab"
                aria-selected={pane === p.key}
                onClick={() => setPane(p.key)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', cursor: 'pointer', border: 'none',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                  background: pane === p.key ? 'var(--cth-cream-100)' : 'transparent',
                  boxShadow: pane === p.key
                    ? `inset 0 -2px 0 var(--cth-${agent.accent})`
                    : 'none',
                  color: pane === p.key ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
                }}
              >
                <Icon name={p.icon} /> {p.label}
              </button>
            ))}
          </div>

          {/* Upper pane — history / diff / mail. Sized so the terminal below
              always keeps a readable share of the column. */}
          <div style={{ flex: '0 0 42%', minHeight: 140, display: 'flex', overflow: 'hidden' }}>
            {pane === 'activity' && <ToolWaterfall agentId={agent.id} />}
            {pane === 'changes' && <GitTab cwd={agent.worktreePath || agent.cwd} />}
            {pane === 'messages' && <ThreadsPanel agentId={agent.id} />}
          </div>

          {/* Terminal — the agent in its own words. */}
          <div style={{
            flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            borderTop: '1px solid var(--cth-ink-300)'
          }}>
            {live && agent.ptyId && !ptyIsElsewhere ? (
              <>
                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                  <PtyTerminalView
                    key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                    ptyId={agent.ptyId}
                    onStreamData={onPtyStream}
                    onUserPrompt={(t) => {
                      updateAgent(agent.id, { lastPrompt: t });
                      if (t.trim().toLowerCase() === '/clear') {
                        updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                      }
                      void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                    }}
                    onToggleFullscreen={() => setFullscreen(agent.id)}
                    fullscreen={false}
                    embedded
                  />
                </div>
                <MessageQueueComposer agent={agent} />
              </>
            ) : (
              <div style={{
                flex: 1, display: 'grid', placeItems: 'center', padding: 16,
                background: 'var(--cth-paper-200)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-md)',
                color: 'var(--cth-ink-500)', textAlign: 'center'
              }}>
                {ptyIsElsewhere
                  ? 'This terminal is open in fullscreen. Exit fullscreen to bring it back here.'
                  : 'No live process for this agent.'}
              </div>
            )}
          </div>
        </div>

        {/* right rail: gauges + intervention */}
        <div style={{
          width: 312, flex: '0 0 312px', minHeight: 0, overflowY: 'auto',
          padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 14,
          background: 'var(--cth-paper-200)',
          borderLeft: '1px solid var(--cth-ink-300)'
        }}>
          <div>
            <div style={railLabel}>Context</div>
            <div style={{ height: 5, background: 'var(--cth-cream-300)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round(pct * 100)}%`, background: ctxColor }} />
            </div>
            <div style={mono}>
              {limit > 0 ? `${compact(ctx)} / ${compact(limit)} · ${Math.round(pct * 100)}%` : 'not reported yet'}
            </div>
          </div>

          <div>
            <div style={railLabel}>Spend</div>
            <div style={{ ...mono, color: 'var(--cth-ink-900)', fontSize: 'var(--cth-text-mono-md)' }}>
              {sample ? `$${sample.usd.toFixed(2)}` : '—'}
            </div>
            <div style={mono}>
              {sample ? `${compact(totalTokens(sample))} tokens · ${sample.model || 'model unknown'}` : 'no usage recorded yet'}
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--cth-ink-100)' }} />

          <InterveneRail agentId={agent.id} live={live} />
        </div>
      </div>
    </div>
  );
}

const railLabel: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 'var(--cth-text-display-sm)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--cth-ink-500)',
  marginBottom: 5
};

const mono: React.CSSProperties = {
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 'var(--cth-text-mono-sm)',
  color: 'var(--cth-ink-500)',
  marginTop: 4
};

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      padding: '1px 6px',
      fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
      color: 'var(--cth-ink-700)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
      whiteSpace: 'nowrap'
    }}>{children}</span>
  );
}
