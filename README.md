# 🐙 polvo

A terminal coding agent, built by hand in small, readable increments — the
goal is to understand every line, then grow it toward (and past) the polish of
tools like Claude Code.

> *polvo* — Portuguese for **octopus**: a model with many tool-wielding arms.

## Status: v0.0.1

A streaming chat REPL. You type, the model answers, the conversation is kept in
memory for the session. **No tools yet** — that's the next increment. What this
version establishes:

- the project skeleton (TypeScript, ESM, run-without-build via `tsx`);
- a backend-agnostic `Provider` seam (`src/provider.ts`) so a local model or a
  different API is a new class, not a rewrite;
- streaming output and a clean REPL loop (`src/repl.ts`).

## Run it

```bash
cd ~/dev/polvo
npm install                      # once
export ANTHROPIC_API_KEY=sk-...  # required to reach the model
npm run dev                      # start chatting
```

Useful variants:

```bash
npm run dev -- --help            # flags & commands
npm run dev -- --model claude-haiku-5-5   # cheap model for iterating
POLVO_MODEL=claude-haiku-5-5 npm run dev  # same, via env
npm run typecheck                # tsc --noEmit
echo "/exit" | npm run dev       # non-interactive smoke test
```

The default model is `claude-opus-5-5`. For the fast dev loop you'll likely
want `claude-haiku-5-5` (far cheaper); switch with `--model` or `$POLVO_MODEL`.

## Layout

| File | Role |
|------|------|
| `src/index.ts`    | entry: arg parsing, wiring, startup |
| `src/config.ts`   | model + system prompt resolution |
| `src/provider.ts` | the model-backend interface + Anthropic implementation |
| `src/repl.ts`     | the read → ask → stream loop |
| `src/ui.ts`       | tiny ANSI helpers (no dependency) |

## Roadmap (one small increment at a time)

1. ✅ **v0.0.1** — streaming chat REPL + provider seam.
2. **v0.0.2** — the tool loop: let the model call tools and feed results back.
3. **v0.0.3** — first tools: `read_file`, `list_dir`.
4. **v0.0.4** — `write_file` / edits, with a confirmation gate.
5. **v0.0.5** — `run_bash`, sandboxed.
6. **v0.1.0** — a real TUI (Ink), slash commands, config file.
7. later — local model provider, context management, subagents.
