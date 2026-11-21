# 🐙 polvo

A terminal coding agent, built by hand in small, readable increments — the goal
is to understand every line, then grow it toward (and past) the polish of tools
like Claude Code. It runs on a **local** model via Ollama: nothing leaves your
machine.

> *polvo* — Portuguese for **octopus**: a model with many tool-wielding arms.

## Status: v0.0.1

A streaming chat REPL against a local Ollama model. You type, the model answers,
the conversation is kept in memory for the session. **No tools yet** — that's the
next increment. What this version establishes:

- the project skeleton (TypeScript, ESM, run-without-build via `tsx`);
- a backend-agnostic `Provider` seam (`src/provider.ts`) so swapping models — or
  adding a remote backend later — is a new class, not a rewrite of the loop;
- streaming output, a clean REPL loop, and an Ollama preflight check.

## Prerequisites

- Node ≥ 20.
- Ollama running locally with a model pulled:
  ```bash
  ollama serve                   # if not already running
  ollama pull qwen3-coder:30b    # the default (already present on this machine)
  ```

## Run it

```bash
cd ~/dev/polvo
npm install        # once
npm run dev        # chat with the default model
```

Or, once the alias is loaded (open a new shell), from **any** directory:

```bash
polvo                        # default model (qwen3-coder:30b)
polvo --model llama3.1:8b    # snappier, smaller
polvo --help
```

Config:

| Flag / env | Meaning | Default |
|---|---|---|
| `--model <id>` / `$POLVO_MODEL` | Ollama model | `qwen3-coder:30b` |
| `$OLLAMA_HOST` | Ollama server | `http://127.0.0.1:11434` |
| `$NO_COLOR` | disable color | — |

The default **`qwen3-coder:30b`** is the best fit for this box (MoE, ~3B active,
fits in RAM) — capable but modest-speed on CPU. Use **`llama3.1:8b`** when you
want fast iteration.

## Layout

| File | Role |
|------|------|
| `src/index.ts`    | entry: arg parsing, preflight, wiring |
| `src/config.ts`   | model + system prompt resolution |
| `src/provider.ts` | the model-backend interface + Ollama implementation |
| `src/repl.ts`     | the read → ask → stream loop |
| `src/ui.ts`       | tiny ANSI helpers (no dependency) |

## Known limits (v0.0.1, adversary-reviewed)

Deliberately out of scope this increment, each scheduled where it fits best:

- multi-line paste is sent as separate turns → multi-line input (later);
- Ctrl-C ends the process, not just the current turn → cancel path (v0.0.2);
- model output isn't stripped of terminal control codes → added when
  file-reading lands (v0.0.3), where the injection vector actually appears;
- no arrow-key line editing / history → the TUI pass (v0.1.0).

## Roadmap (one small, reviewable increment at a time)

1. ✅ **v0.0.1** — streaming chat REPL + provider seam (local Ollama).
2. **v0.0.2** — the tool loop + a cancel (Ctrl-C) path.
3. **v0.0.3** — first tools: `read_file`, `list_dir` (+ output sanitization).
4. **v0.0.4** — `write_file` / edits, with a confirmation gate.
5. **v0.0.5** — `run_bash`, sandboxed.
6. **v0.1.0** — a real TUI (Ink), line editing, slash commands, config file.
7. later — more backends via the same `Provider` interface, context management,
   subagents.
