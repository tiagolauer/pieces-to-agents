---
name: Bug report
about: Something went wrong while running the tool
labels: bug
---

## Before you paste anything

This tool reads your Long-Term Memory, which holds whatever was on your screen. The diff it
prints, and the file it writes, can contain your employer's code, other people's names, or your
own private notes.

Do not paste your generated `AGENTS.md` or `CLAUDE.md` here, and do not paste the diff. Describe
the shape of the problem instead, or redact heavily before pasting a single line.

If the bug is that something private got through the filters, please report it privately instead.
See [SECURITY.md](../../SECURITY.md).

## What happened

## What you expected

## How to reproduce

The command you ran, with any flags:

```
npx pieces-to-agents
```

## Environment

- Tool version (`npx pieces-to-agents --version`):
- PiecesOS version:
- Node version (`node --version`):
- Operating system:

## Exit code

The number printed by `echo $?` on a shell, or `$LASTEXITCODE` on PowerShell, right after the run.
