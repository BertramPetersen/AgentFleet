// REPL driver for the AgentFleet Electron app.
//
// Launches the built app under Playwright's _electron and exposes a line-based
// command REPL, so an agent can drive the real UI and look at real screenshots
// instead of inferring behaviour from a typecheck.
//
// Read .claude/skills/run-desktop/SKILL.md before changing this.
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.run-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let app = null;
let page = null;
const consoleLines = [];

/** Driver runs get their own Electron userData dir, so config.json, the SQLite
 *  store and the hive they point at are all throwaway — driving the UI can never
 *  touch the operator's real state, and every run starts from a known place.
 *  Seeded with onboardingComplete + a scratch harnessHome unless FRESH=1, which
 *  is how you exercise the onboarding wizard itself. */
function userDataDir() {
  const dir = process.env.DRIVER_USER_DATA || path.join(APP_DIR, '.run-userdata');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.json');
  if (process.env.FRESH === '1') {
    fs.rmSync(cfg, { force: true });
    return dir;
  }
  if (!fs.existsSync(cfg)) {
    const hive = path.join(APP_DIR, '.run-hive');
    fs.mkdirSync(hive, { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ onboardingComplete: true, harnessHome: hive }, null, 2));
  }
  return dir;
}

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.js'))) {
      return console.log('ERROR: out/main/index.js missing — run `npm run build` first');
    }
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [APP_DIR, `--user-data-dir=${userDataDir()}`],
      timeout: 60_000
    });
    page = await app.firstWindow();
    page.on('console', (m) => {
      const line = `[${m.type()}] ${m.text()}`;
      consoleLines.push(line);
      if (m.type() === 'error') console.log('PAGE ERROR:', m.text());
    });
    page.on('pageerror', (e) => {
      consoleLines.push(`[pageerror] ${e.message}`);
      console.log('PAGE EXCEPTION:', e.message);
    });
    // The splash sits in #root until React mounts over it, so "ready" is the
    // splash being gone — not load, which fires while the splash is still up.
    try {
      await page.waitForFunction(() => !document.querySelector('#cth-splash'), null, { timeout: 30_000 });
      console.log('launched — React mounted');
    } catch {
      console.log('launched — WARNING: splash never cleared (renderer may have thrown)');
    }
    for (const w of app.windows()) console.log('  window:', w.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const file = path.join(SHOT_DIR, `${name || `ss-${consoleLines.length}`}.png`);
    await page.screenshot({ path: file });
    console.log('screenshot:', file);
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate(
      (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null
    ));
  },

  // DOM click, not locator.click(): coordinate-based clicking lands on the
  // wrong layer whenever a modal or overlay is up, which in this app is often.
  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log('click', sel, '→', await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK';
    }, sel));
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    console.log('click-text', JSON.stringify(text), '→', await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      let el = els.find((e) => e.textContent?.trim() === t)
        ?? els.find((e) => e.textContent?.includes(t));
      // This app makes rows and cards clickable as styled DIVs with onClick, so
      // fall back to the tightest text match and climb to the nearest ancestor
      // that renders a pointer cursor — that is the element React listens on.
      if (!el) {
        const leaf = [...document.querySelectorAll('span, div, td, p')]
          .filter((e) => e.childElementCount === 0 && e.textContent?.trim() === t)[0]
          ?? [...document.querySelectorAll('span, div, td, p')]
            .filter((e) => e.childElementCount === 0 && e.textContent?.includes(t))[0];
        for (let p2 = leaf; p2; p2 = p2.parentElement) {
          if (getComputedStyle(p2).cursor === 'pointer') { el = p2; break; }
        }
      }
      if (!el) return 'NOT_FOUND';
      el.click();
      return `OK: <${el.tagName.toLowerCase()}> ${el.textContent?.trim().slice(0, 40)}`;
    }, text));
  },

  // React-controlled inputs ignore both keyboard.type() into a focused element
  // and a plain `el.value = x`: the component's state is the source of truth, so
  // the value has to go through the property's NATIVE setter and then announce
  // itself with a bubbling 'input' event for React's onChange to see it.
  // Usage: fill <css-selector>|<text>
  async fill(arg) {
    if (!page) return console.log('ERROR: launch first');
    const idx = arg.indexOf('|');
    if (idx < 0) return console.log('usage: fill <css-selector>|<text>');
    const sel = arg.slice(0, idx).trim();
    const text = arg.slice(idx + 1);
    console.log('fill', sel, '→', await page.evaluate(({ sel, text }) => {
      const el = document.querySelector(sel);
      if (!el) return 'NOT_FOUND';
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return 'NO_SETTER';
      el.focus();
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return `OK len=${el.value.length}`;
    }, { sel, text }));
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try {
      await page.waitForSelector(sel, { timeout: 15_000 });
      console.log('found:', sel);
    } catch {
      console.log('TIMEOUT:', sel);
    }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },

  /** Everything the renderer logged, including errors that never reach the UI. */
  logs() { console.log(consoleLines.length ? consoleLines.join('\n') : '(no console output)'); },

  /** Which store-backed agents the UI currently believes exist. */
  async agents() {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-agent-id]')];
      return rows.length
        ? rows.map((r) => r.getAttribute('data-agent-id') + ' :: ' + r.innerText.replace(/\n/g, ' | ')).join('\n')
        : '(no [data-agent-id] rows rendered)';
    }));
  },

  // app.close() alone is NOT enough: with a live agent PTY the app raises its
  // quit-confirmation modal and refuses to go, leaving Electron (and the real
  // agent process it spawned) running after the driver exits. So: ask nicely,
  // then kill the process tree.
  async quit() {
    if (!app) return;
    const proc = app.process();
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000))
    ]);
    try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch { /* already gone */ }
    app = null; page = null;
    console.log('stopped');
  },

  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); }
};

// Electron grabs the inherited stdin; read the fd directly so the REPL keeps its input.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) { console.log('unknown:', cmd, '— try: help'); return rl.prompt(); }
  try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
  if (cmd === 'quit') { rl.close(); process.exit(0); }
  rl.prompt();
});
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });

console.log('AgentFleet driver — "help" for commands, "launch" to start');
rl.prompt();
