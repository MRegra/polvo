# 🐙 polvo

A terminal coding agent, built by hand in small, readable increments. It runs on
a **local** model via Ollama: nothing leaves your machine.

> *polvo* — Portuguese for **octopus**: a model with many tool-wielding arms.

## Design rule: the model proposes, the harness checks

A local 30B model is capable but unreliable, so anything code can verify is
not left to the model:

| Guarantee | Enforced by |
|---|---|
| Edits are exact and small | `edit_file`: `old_string` must match once (or `replace_all`), file must have been read and unchanged since |
| Nothing changes without you | approval prompt for every write/edit and every non-read-only command (with a diff) |
| No shell injection | `run_command` has no shell: argv + `spawn`, shell syntax rejected, read-only allowlist, timeout kills the whole process tree |
| "Done" means the checks pass | after file changes the harness runs `.polvo.json` `checks` and feeds failures back (max `maxFixAttempts`) |
| No runaway turns | step limit (default 25); repeated identical tool calls are refused, then the turn stops |
| Context never overflows | tool output capped (head+tail); history trimmed before every model call, in one batch, at turn boundaries |
| Plans before big changes | `/plan <task>` runs a read-only turn: write tools are withheld, not just discouraged |

## Install

Needs git, Node.js ≥ 20 and [Ollama](https://ollama.com) with a model pulled
(`ollama pull qwen3-coder:30b`).

```bash
# fresh machine: clones into ~/.local/share/polvo (override with POLVO_DIR)
curl -fsSL https://raw.githubusercontent.com/MRegra/polvo/master/scripts/install.sh | bash

# or from a checkout you already have
git clone https://github.com/MRegra/polvo.git && cd polvo
./scripts/install.sh
```

The script checks the prerequisites, runs `npm ci` and the build, and `npm link`s
a global `polvo` command that points into the checkout. With nvm, the link
belongs to the active Node version — run the script again after switching.

## Update

```bash
polvo update --check   # is there anything new on master?
polvo update           # git pull --ff-only, npm ci, build
```

`polvo update` works on the checkout polvo runs from. It refuses when that
checkout has uncommitted changes or is not on `master` (it would be your work),
and if the new build fails it rolls back to the previous commit so the command
keeps working. Uninstall with `npm unlink -g polvo`.

## Run it

```bash
polvo                        # the TUI, in the current directory
npm run dev                  # same, straight from the sources (no build)
polvo --model qwen3:8b       # smaller/faster model
polvo monitor                # system check, no model needed (exit 0 ok · 1 warn · 2 critical)
polvo monitor --json
```

| Env | Meaning | Default |
|---|---|---|
| `POLVO_MODEL` | Ollama model | `qwen3-coder:30b` |
| `POLVO_NUM_CTX` | context window (tokens) | `32768` |
| `POLVO_KEEP_ALIVE` | keep model loaded when idle | `10m` |
| `POLVO_MAX_STEPS` | model calls per turn | `25` |
| `OLLAMA_HOST` | Ollama server | `http://127.0.0.1:11434` |

Per project, `.polvo.json` (all optional):

```json
{ "checks": ["npm run typecheck", "npm test"], "maxFixAttempts": 3, "numCtx": 32768 }
```

Checks are your own shell commands; polvo asks you to approve them once per
session (a cloned repo can ship a `.polvo.json` too).

polvo's own repo ships one (typecheck + tests), so when you point polvo at its
own code, its changes are only "done" once those pass. Do that in a separate
worktree so the installed command keeps running `master`:

```bash
git -C ~/dev/polvo worktree add ../polvo-dev -b my-change
cd ~/dev/polvo-dev && npm ci && polvo
```

## Memory

RAM ≈ model weights + KV cache. For `qwen3-coder:30b` on CPU: ~18 GB of weights
plus **~94 MB per 1k tokens of context**, reserved up front. The old 200k
default cost ~18 GB on its own; 32k costs ~3 GB.

Ollama server settings (`~/.config/systemd/user/ollama.service`, `[Service]`):

```ini
Environment="OLLAMA_FLASH_ATTENTION=1"     # required for a quantized KV cache
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"    # halves KV memory, ~no quality loss
Environment="OLLAMA_MAX_LOADED_MODELS=1"   # CPU default is 3
Environment="OLLAMA_NUM_PARALLEL=1"        # KV memory is multiplied by this
```

then `systemctl --user daemon-reload && systemctl --user restart ollama`.

- Keep `numCtx` constant: a different value per request reloads the model.
- polvo unloads its model on exit; `POLVO_KEEP_ALIVE=0` unloads after every reply.
- For monitoring questions a small model (`qwen3:4b`, ~3 GB) is plenty.

## Monitoring

`polvo monitor` collects memory, memory pressure (PSI), load, disk, failed
systemd units, journal errors from the last hour, top processes and loaded
Ollama models, then applies fixed thresholds (`src/monitor.ts`). No model is
involved, so it is cheap enough for a timer:

```ini
# ~/.config/systemd/user/polvo-monitor.service
[Service]
Type=oneshot
ExecStart=/usr/bin/env polvo monitor

# ~/.config/systemd/user/polvo-monitor.timer
[Timer]
OnCalendar=*:0/15
[Install]
WantedBy=timers.target
```

Inside the TUI, ask "why is my RAM high?" — the model calls `system_snapshot`
and explains the same data.

## Layout

| File | Role |
|------|------|
| `src/index.ts`    | entry: args, `monitor` subcommand, preflight, renders the TUI |
| `src/app.tsx`     | the TUI (scrollback, input, approvals, `/plan`) |
| `src/agent.ts`    | the turn loop: approvals, limits, loop detection, checks |
| `src/tools.ts`    | `read_file`, `list_dir`, `edit_file`, `write_file`, `run_command`, `system_snapshot` |
| `src/command.ts`  | shell-free command parsing, read-only allowlist, process-tree timeouts |
| `src/checks.ts`   | runs `.polvo.json` checks, formats failures for the model |
| `src/context.ts`  | output caps, token estimate, history trimming |
| `src/monitor.ts`  | system collectors + threshold rules |
| `src/provider.ts` | Ollama provider (no fetch timeouts; Esc cancels) |
| `src/config.ts`   | CLI > env > `.polvo.json` > defaults; system prompt |
| `src/update.ts`   | `polvo update`: safe fast-forward + rebuild of the install checkout |
| `src/version.ts`  | version read from `package.json` (the only place to bump) |
| `scripts/install.sh` | installer: prerequisites, build, `npm link` |

`npm test` runs the unit tests (`test/`, node:test); CI runs typecheck, tests,
build and shellcheck on Node 20 and 22. To release, bump `version` in
`package.json` only.

## Next

- `prompt_eval_cached_count` in the status bar, to see prompt-cache hits.
- monitor rules with a "for N minutes" window (needs a small state file).
- line-numbered `read_file` ranges.
