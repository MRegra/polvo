# 🐙 polvo

A terminal coding agent, built by hand in small, readable increments — the goal
is to understand every line, then grow it toward (and past) the polish of tools
like Claude Code. It runs on a **local** model via Ollama: nothing leaves your
machine.

> *polvo* — Portuguese for **octopus**: a model with many tool-wielding arms.

## Status: v0.1.0

A full-screen terminal UI (Ink / React). The conversation scrolls above; you
type in a fixed box at the bottom. While a reply is generating, input is locked
and a spinner shows — keystrokes can't leak into the output. Still **no tools**:
on submit it streams the model's reply, nothing more.

What's in place:

- backend-agnostic `Provider` seam (`src/provider.ts`) — Ollama today, other
  backends later, without touching the UI;
- an Ink TUI (`src/app.tsx`): `<Static>` scrollback, a bottom input box, a
  thinking spinner, raw-mode input so nothing echoes mid-reply;
- an Ollama preflight (server/model reachable) surfaced in-app.

## Prerequisites

- Node ≥ 20.
- Ollama running locally with a model pulled:
  ```bash
  ollama serve                   # if not already running
  ollama pull qwen3-coder:30b    # the default
  ```

## Run it

```bash
cd ~/dev/polvo
npm install        # once
npm run dev        # launch the TUI
```

Or, once the alias is loaded (new shell), from **any** directory:

```bash
polvo                        # default model (qwen3-coder:30b)
polvo --model llama3.1:8b    # snappier, smaller
polvo --help
```

| Flag / env | Meaning | Default |
|---|---|---|
| `--model <id>` / `$POLVO_MODEL` | Ollama model | `qwen3-coder:30b` |
| `$OLLAMA_HOST` | Ollama server | `http://127.0.0.1:11434` |

`qwen3-coder:30b` is the best fit for this box (MoE, ~3B active) but CPU-bound;
`llama3.1:8b` is the snappy option. It also holds ~19 GB of RAM while loaded and
auto-unloads 5 min after the last message (`ollama stop <model>` to free it now).

## Layout

| File | Role |
|------|------|
| `src/index.ts`    | entry: arg parsing, preflight, renders the Ink app |
| `src/app.tsx`     | the whole TUI (history, input box, streaming) |
| `src/provider.ts` | the model-backend interface + Ollama implementation |
| `src/config.ts`   | model + system prompt resolution |

## Roadmap (one small, reviewable increment at a time)

1. ✅ **v0.0.1** — streaming chat REPL + provider seam (local Ollama).
2. ✅ **v0.1.0** — full-screen Ink TUI (bottom input, scrollback, locked input).
3. **v0.2.0** — the tool loop + `read_file` / `list_dir` → **polvo can read its
   own code and suggest improvements** (read-only; nothing can modify anything).
4. **v0.3.0** — `write_file` / edits, with a confirmation gate.
5. **v0.4.0** — `run_bash`, sandboxed.
6. later — cancel/Esc a turn, slash commands, config file, more backends,
   context management, subagents.
