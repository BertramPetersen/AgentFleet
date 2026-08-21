---
name: run-desktop
description: Build, run, and drive the AgentFleet Electron desktop app. Use when asked to start the app, screenshot it, verify a UI change actually works, or interact with its interface.
---

AgentFleet is an Electron desktop app. Drive it through the Playwright REPL at
`.claude/skills/run-desktop/driver.mjs` — launch, screenshot, click, read text,
read the renderer console. **Look at the screenshots.** A typecheck proves the
types line up; only a screenshot proves the app works.

## Node 20 is mandatory

Not a preference. On Node 22+ the `postinstall` (`electron-rebuild`) dies with
`ReferenceError: require is not defined in ES module scope` — an old `yargs`
inside `@electron/rebuild` that newer Node loads as ESM. `node-pty` then has no
native build and the app cannot spawn a single agent.

```bash
fnm install 20 && fnm use 20      # .node-version pins it
fnm exec --using=20 npm ci        # rebuilds node-pty, downloads Electron
```

Prefix every npm command in this repo with `fnm exec --using=20`, or `fnm use`
first. Node 20 also brings npm 10.8.2, which is what CI runs — see Gotchas.

## Build, then drive

The driver launches the **built** app from `out/`, not the Vite dev server, so
rebuild after changing renderer code:

```bash
fnm exec --using=20 npm run build
```

```bash
tmux kill-session -t af 2>/dev/null
tmux new-session -d -s af -x 200 -y 50
tmux send-keys -t af 'fnm exec --using=20 node .claude/skills/run-desktop/driver.mjs' Enter
tmux send-keys -t af 'launch' Enter          # ~5s; prints "launched — React mounted"
tmux send-keys -t af 'click-text open' Enter # past the harness-config picker
tmux send-keys -t af 'ss 01-shell' Enter
tmux capture-pane -t af -p | tail -20
```

Then read `.run-shots/01-shell.png`.

`timeout` does not exist on this macOS box — poll with a shell loop over
`tmux capture-pane -t af -p | grep -q ...` instead of `timeout ... until`.

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, wait for React to replace the splash |
| `ss [name]` | screenshot → `.run-shots/<name>.png` |
| `text [sel]` | print `innerText` of a selector, or the whole body |
| `click <sel>` / `click-text <text>` | click via DOM (not coordinates). Matches buttons/links first, then any text leaf whose nearest `cursor: pointer` ancestor is clickable — so backlog rows and cards work too |
| `wait <sel>` | wait up to 15s for a selector |
| `eval <js>` | evaluate in the renderer, print JSON |
| `agents` | list rendered `[data-agent-id]` rows |
| `logs` | everything the renderer logged, including swallowed errors |
| `quit` | close the app and kill the process tree |

## State is isolated

Each run gets `--user-data-dir=.run-userdata` with a seeded
`config.json` (`onboardingComplete: true`, `harnessHome: .run-hive`), so driving
the UI can never touch a real hive and always starts from the same place. All
three `.run-*` directories are gitignored.

- `FRESH=1` deletes the seeded config, so you land in the onboarding wizard —
  that is how you test onboarding itself.
- `DRIVER_USER_DATA=<dir>` for a second, independent profile.
- `SCREENSHOT_DIR=<dir>` to move the screenshots.

## Launching spawns a real agent

Getting past the config picker boots the god agent (Michael) as a **real
`claude` process against your subscription**. It is not a mock and it starts
orchestrating on its own. Verify what you need and `quit` — don't leave it
running while you go and write code.

## Gotchas

- **`app.close()` does not close it.** With a live PTY the app raises its
  quit-confirmation modal and refuses. `quit` handles this (close, 5s, SIGKILL);
  if you kill the driver another way, check for orphans with
  `pgrep -f "dist/Electron.app"` — an orphan keeps a real agent alive.
- **Never regenerate `package-lock.json` on npm 11.** It silently drops
  `node_modules/@openai/agents-core/node_modules/ws`, which satisfies a
  `ws ^8.18.0` peer under npm 10 — so `npm ci` passes locally and fails in CI on
  a byte-identical lock. Use Node 20's npm 10.8.2 and verify with
  `fnm exec --using=20 npm ci`.
- **Wait for the splash to go, not for `load`.** `#cth-splash` is inside `#root`
  and `load` fires while it is still up; a screenshot then shows the splash. The
  driver waits for its removal, and warns if it never clears — which is what a
  renderer exception looks like from outside.
- **First screen is the harness-config picker**, not the main shell.
  `click-text open` gets through it.
- **Use DOM clicks.** This app puts modals and overlays over the shell;
  coordinate-based `locator.click()` lands on the wrong layer.

## Human path

```bash
fnm exec --using=20 npm run dev    # electron-vite dev, hot reload, real window
```
