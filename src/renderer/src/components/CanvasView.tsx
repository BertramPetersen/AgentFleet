import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { agentsInProject, type Project } from '@/store/projects';
import { AgentAvatar } from './AgentAvatar';
import { Icon } from './Icon';

/**
 * CANVAS — where agents show what they're building.
 *
 * An agent that wants to communicate visually writes a self-contained HTML
 * file into `.canvas/` in its working directory; every such artifact appears
 * here, newest first, and renders in a sandboxed frame. The list is a poll
 * and the reload key is the file's mtime, so "iterate on the mockup" is just
 * the agent saving the file — the frame refreshes on its own, no watcher, no
 * external browser, nothing published anywhere.
 *
 * The frame is sandboxed to scripts only: artifacts are agent-authored HTML,
 * so they get no same-origin access, no top-level navigation, and each one is
 * served from a tokenized loopback URL that cannot leave its own .canvas/.
 */

const POLL_MS = 3000;

interface Artifact { agentId: string; file: string; mtimeMs: number; size: number }

function agoLabel(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

export function CanvasView() {
  const agents = useStore((s) => s.agents);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const openInspector = useStore((s) => s.openInspector);

  const [projects, setProjects] = useState<Project[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [server, setServer] = useState<{ port: number; token: string } | null>(null);
  const [selected, setSelected] = useState<{ agentId: string; file: string } | null>(null);
  // The mtime of the artifact currently on screen — bumping it remounts the
  // iframe, which is the entire live-reload mechanism.
  const shownMtime = useRef(0);
  const [frameKey, setFrameKey] = useState(0);

  useEffect(() => {
    let alive = true;
    window.cth.canvasInfo?.().then((i) => { if (alive && i.port) setServer(i); }).catch(() => { /* hive off */ });
    const read = (): void => {
      window.cth.canvasList?.().then((list) => { if (alive) setArtifacts(list ?? []); }).catch(() => { /* hive off */ });
      window.cth.projectsList?.().then((list) => { if (alive) setProjects(list ?? []); }).catch(() => { /* hive off */ });
    };
    read();
    const t = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const scope = projects.find((p) => p.id === activeProjectId) ?? null;
  const scopedAgentIds = useMemo(() => {
    const live = agents.filter((a) => !a.archived);
    const inScope = scope ? agentsInProject(live, scope) : live;
    return new Set(inScope.map((a) => a.id));
  }, [agents, scope]);

  const visible = artifacts.filter((a) => scopedAgentIds.has(a.agentId));
  const current = selected
    ? visible.find((a) => a.agentId === selected.agentId && a.file === selected.file) ?? null
    : visible[0] ?? null;

  // Live reload: the poll moved the open artifact's mtime → remount the frame.
  useEffect(() => {
    if (!current) return;
    if (shownMtime.current !== 0 && current.mtimeMs !== shownMtime.current) setFrameKey((k) => k + 1);
    shownMtime.current = current.mtimeMs;
  }, [current?.mtimeMs, current?.agentId, current?.file]);

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const src = current && server
    ? `http://127.0.0.1:${server.port}/t/${server.token}/${encodeURIComponent(current.agentId)}/${encodeURIComponent(current.file)}`
    : null;

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
        }}>Canvas</span>
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-ink-500)'
        }}>
          {visible.length === 0 ? 'no artifacts yet' : `${visible.length} artifact${visible.length === 1 ? '' : 's'}`}
        </span>
        {current && (
          <span style={{
            marginLeft: 'auto', fontFamily: 'var(--cth-font-mono)',
            fontSize: 'var(--cth-text-mono-sm)', color: 'var(--cth-ink-500)'
          }}>
            {current.file} · updated {agoLabel(current.mtimeMs)}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* artifact list */}
        <div style={{
          width: 240, flex: '0 0 240px', minHeight: 0, overflowY: 'auto',
          borderRight: '1px solid var(--cth-ink-100)', background: 'var(--cth-cream-200)',
          padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 2
        }}>
          {visible.length === 0 && (
            <p style={{
              margin: '8px 8px', fontFamily: 'var(--cth-font-ui)',
              fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)', lineHeight: 1.5
            }}>
              When an agent writes an HTML file into <code style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
                background: 'var(--cth-paper-100)', padding: '0 4px', borderRadius: 4
              }}>.canvas/</code> in its working directory, it shows up here and re-renders
              on every save. Ask any agent to mock something up.
            </p>
          )}
          {visible.map((a) => {
            const agent = agentOf(a.agentId);
            const on = current === a;
            return (
              <button
                key={`${a.agentId}/${a.file}`}
                onClick={() => { shownMtime.current = 0; setSelected({ agentId: a.agentId, file: a.file }); }}
                title={`${a.file} — ${agent?.name ?? a.agentId} · updated ${agoLabel(a.mtimeMs)}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '6px 8px', border: 'none', cursor: 'pointer',
                  borderRadius: 'var(--cth-radius-sm)',
                  background: on ? 'var(--cth-paper-200)' : 'transparent'
                }}
              >
                {agent
                  ? <AgentAvatar name={agent.name} accent={agent.accent} scale={0.75} />
                  : <Icon name="image" />}
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                    color: on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>{a.file.replace(/\.html?$/i, '')}</span>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                    color: 'var(--cth-ink-500)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>{agent?.name ?? a.agentId} · {agoLabel(a.mtimeMs)}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* viewer */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {src ? (
            <>
              <iframe
                key={frameKey}
                src={src}
                sandbox="allow-scripts"
                title={current?.file}
                style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#FFFFFF' }}
              />
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
                borderTop: '1px solid var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                color: 'var(--cth-ink-500)'
              }}>
                <span>re-renders on save · sandboxed</span>
                {current && agentOf(current.agentId) && (
                  <button
                    onClick={() => openInspector(current.agentId)}
                    style={{
                      marginLeft: 'auto', padding: '1px 8px', border: 'none', cursor: 'pointer',
                      borderRadius: 'var(--cth-radius-sm)',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
                      color: 'var(--cth-ink-900)'
                    }}
                  >
                    steer {agentOf(current.agentId)?.name} ›
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={{
              flex: 1, display: 'grid', placeItems: 'center', padding: 24,
              fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', textAlign: 'center'
            }}>
              <div>
                <div style={{ fontSize: 'var(--cth-text-body-md)', marginBottom: 6 }}>Nothing on the canvas.</div>
                <div style={{ fontSize: 'var(--cth-text-body-sm)', maxWidth: 440, lineHeight: 1.5 }}>
                  Ask an agent to mock something up — anything it writes to{' '}
                  <code style={{ fontFamily: 'var(--cth-font-mono)' }}>.canvas/*.html</code> in its
                  working directory renders here, live.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
