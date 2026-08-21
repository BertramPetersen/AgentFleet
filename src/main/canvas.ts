/**
 * Canvas — agents show their work as HTML artifacts, rendered inside the app.
 *
 * The contract is a FOLDER, not a protocol: an agent writes self-contained
 * HTML files into `.canvas/` in its working directory (its worktree when
 * isolated), and the Canvas view renders them. Multiple artifacts per agent;
 * relative assets next to the HTML work too. No external browser is ever
 * spawned and nothing is published anywhere — this replaces the
 * open-a-browser-tab workflow, deliberately (decision D4).
 *
 * Serving happens over a loopback HTTP server rather than file:// because the
 * renderer sandboxes artifacts in an iframe: same-origin file access from a
 * sandboxed frame is a non-starter, while `frame-src http://127.0.0.1:*` is a
 * one-line CSP carve-out. The server is guarded three ways: loopback bind, an
 * unguessable per-launch token in the path, and a resolved-path check that
 * every request stays inside that agent's own `.canvas/`.
 */

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

export const CANVAS_DIR = '.canvas';

export interface CanvasArtifact {
  agentId: string;
  /** File name inside the agent's .canvas/ (top level only). */
  file: string;
  mtimeMs: number;
  size: number;
}

export interface CanvasServerDeps {
  /** The agent's working root (worktree when isolated), or null when unknown.
   *  Canvas only ever serves from `<root>/.canvas/`. */
  agentRoot: (agentId: string) => string | null;
}

export class CanvasServer {
  private server: Server | null = null;
  private port = 0;
  private token = randomBytes(16).toString('hex');

  constructor(private deps: CanvasServerDeps) {}

  info(): { port: number; token: string } {
    return { port: this.port, token: this.token };
  }

  /** Every artifact across the given agents — the renderer polls this and
   *  reloads the open artifact when its mtime moves, so live-iteration needs
   *  no file watcher and survives worktrees appearing and disappearing. */
  list(agentIds: string[]): CanvasArtifact[] {
    const out: CanvasArtifact[] = [];
    for (const agentId of agentIds) {
      const root = this.deps.agentRoot(agentId);
      if (!root) continue;
      const dir = join(root, CANVAS_DIR);
      if (!existsSync(dir)) continue;
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!/\.html?$/i.test(file)) continue;
        try {
          const st = statSync(join(dir, file));
          if (st.isFile()) out.push({ agentId, file, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* raced a delete */ }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  start(): Promise<{ port: number; token: string }> {
    if (this.server) return Promise.resolve(this.info());
    this.server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // /t/<token>/<agentId>/<path inside .canvas>
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 4 || parts[0] !== 't' || parts[1] !== this.token) {
          res.writeHead(404).end();
          return;
        }
        const agentId = decodeURIComponent(parts[2]);
        const rel = parts.slice(3).map(decodeURIComponent).join('/');
        const root = this.deps.agentRoot(agentId);
        if (!root) { res.writeHead(404).end(); return; }
        const base = resolve(join(root, CANVAS_DIR));
        const target = resolve(join(base, rel));
        if (target !== base && !target.startsWith(base + sep)) {
          res.writeHead(403).end(); // traversal attempt — never leave .canvas/
          return;
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          // Artifacts are actively iterated on — never let the frame cache one.
          'Cache-Control': 'no-store'
        });
        createReadStream(target).pipe(res);
      } catch {
        try { res.writeHead(500).end(); } catch { /* socket gone */ }
      }
    });
    return new Promise((resolvePort, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolvePort(this.info());
      });
    });
  }

  stop(): void {
    try { this.server?.close(); } catch { /* already down */ }
    this.server = null;
  }
}
