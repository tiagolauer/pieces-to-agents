<div align="center">

# pieces-to-agents

**Turn your [Pieces](https://pieces.app/) Long-Term Memory into an `AGENTS.md`.**

PiecesOS records what you work on all day. Your coding agent starts every session with none of it.
This CLI reads your memory over MCP and writes the parts that belong to a repository into its
context file, so the next agent already knows why the code looks the way it does.

[![CI](https://github.com/tiagolauer/pieces-to-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagolauer/pieces-to-agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-brightgreen.svg)](https://nodejs.org)
[![Requires PiecesOS](https://img.shields.io/badge/requires-PiecesOS-orange.svg)](https://pieces.app/)
[![Protocol: MCP](https://img.shields.io/badge/protocol-MCP-8A2BE2.svg)](https://modelcontextprotocol.io/)

</div>

---

## Table of contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Options](#options)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Writing memories on purpose](#writing-memories-on-purpose)
- [Inspecting your own PiecesOS](#inspecting-your-own-piecesos)
- [Known limits](#known-limits)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Agent context files have become the standard way to tell Claude Code, Cursor or Copilot how a
project works. Almost nobody keeps them current, because writing down what you already know is
the first task to get dropped. Meanwhile PiecesOS has been quietly recording the decisions,
the bugs and the dead ends the whole time.

This tool moves one into the other.

| Principle | What it means in practice |
|---|---|
| Local only | Every call goes to `localhost:39300`. No account, no telemetry, no network. |
| Approval before writing | Each run prints a diff and waits for you. There is no flag to skip it. |
| Your own notes survive | Only the text between two markers changes. Everything else is left alone. |
| Scoped to one repository | A memory has to name the project or an alias before it can be used. |
| Redaction before review | Secrets and personal profile data are stripped before you even see the diff. |

## Requirements

- PiecesOS running locally with its MCP server enabled, on the default port `39300`
- Node.js 20.11 or newer
- A git repository to write into

## Getting started

```bash
npm install
npm run sync
```

The run prints a diff of what it wants to add. Read it, then answer `y` to write the file or
anything else to walk away.

## Options

```bash
npm run sync -- --days 30 --target CLAUDE.md --alias ptha --alias "my product"
```

| Flag | Default | Purpose |
|---|---|---|
| `--days` | `14` | How far back to look |
| `--target` | `AGENTS.md` | Write to `AGENTS.md` or `CLAUDE.md` |
| `--project` | repository folder name | The term used to match memories to this project |
| `--alias` | none | Other names this project goes by. Repeat the flag for more than one. |

## How it works

```
vector_search + full_text_search      4 categories, 2 strategies each
        |
        v  identifiers
workstream_summaries_batch_snapshot   session shells and timestamps
        |
        v  annotation ids
annotations_batch_snapshot            the narrative text
        |
        v  filter, redact, compose
AGENTS.md                             between managed markers
```

Both searches run on every category because they fail in opposite ways. Vector search
understands paraphrase but cannot see a memory whose embedding has not been indexed yet, which
means anything written in the last few minutes is invisible to it. Full-text search matches
strictly and immediately, so it catches recent work but misses anything worded differently.
Running both covers the gap.

Text outside the `<!-- pieces-to-agents:start -->` and `<!-- pieces-to-agents:end -->` markers is
never touched, so whatever instructions you wrote by hand survive every run.

There is a second path through the Pieces API, `ask_memory`, which this tool does not use. It
takes around 3.3 seconds and hands back raw screen OCR. The summary chain above takes about 70
milliseconds and hands back markdown that Pieces already wrote for you.

## Privacy

Long-Term Memory captures everything on the machine, not only the repository you happen to be
standing in. That includes your employer's internal code, other people's names, and an
AI-written profile of you. Putting any of it in a file you commit is a leak, so the tool assumes
the worst by default.

Four things stand between your memory and the file:

1. Nothing is written until you approve a diff. This is the control that actually matters, and
   it has no bypass flag.
2. The personal profile PiecesOS keeps about you, stored as `HIERARCHICAL_PROFILE_SUMMARY`, is
   never read. The tool only reads session summaries and descriptions.
3. A memory has to mention your project name or an alias to be eligible. Work on other projects
   is dropped before it reaches the diff.
4. Emails, JWTs, GitHub and Slack tokens and AWS keys are replaced automatically. Names,
   employers and client codenames go in `.pieces-to-agents-ignore`, one per line, and get
   stripped too.

Copy `.pieces-to-agents-ignore.example` to get started. The file is git-ignored.

None of this can catch a name it was never told about, which is why the diff exists. Read it.

## Writing memories on purpose

Passive capture works, but the sharpest entries come from memories your agent wrote deliberately.
PiecesOS exposes `create_pieces_memory` through the same MCP server your agent is already
connected to. Ask it to record decisions as they happen:

> When we finish a meaningful chunk of work, call `create_pieces_memory` with the decisions we
> made, the bugs we fixed and why, and set `project` to this repository's absolute path.

Those become searchable summaries straight away, and the next `sync` picks them up. Your agent
writes down what it worked out, and every agent after it reads that back.

## Inspecting your own PiecesOS

The repository ships a probe with no dependencies, so you can see exactly what your machine
exposes before you trust any of it.

```bash
node probe/inspect-pieces.mjs tools
```

```bash
node probe/inspect-pieces.mjs chain "architecture decisions"
```

The first lists every tool your MCP server offers, which was 69 of them at the time of writing.
The second walks the same three calls the CLI makes and reports the timing plus which annotation
types came back, including the personal profile type this tool refuses to read.

## Known limits

Vector search cannot see memories written moments ago, because embeddings are indexed
asynchronously. Full-text search finds them right away, and this tool runs both, so you should
not notice. A vector-only client will.

The `created` filter on vector search returns nothing at all. The same query gives five results
without it and zero with it, so the time window is applied on this side after fetching.

Project matching is a plain substring test. If your work never writes the project name down,
nothing matches, and `--alias` is the way out.

## Development

```bash
npm run typecheck
npm test
```

Ten tests cover the parts that would fail quietly: splicing the managed block, redaction, the
project filter and composing the output.

## Roadmap

Nothing here is promised. Roughly in order of how much I want it:

- Local NER to catch proper nouns the deny-list was never told about
- A watch mode, or a commit hook
- One managed block per package in a monorepo
- Scoping by absolute project path, if Pieces ever exposes that filter over MCP

## Contributing

Issues and pull requests are welcome. If you are reporting bad output, the probe above is the
fastest way to show what your PiecesOS returned, but check what you paste for anything private
first.

## License

MIT. See [LICENSE](LICENSE).
