<div align="center">

# pieces-to-agents

**Turn your [Pieces](https://pieces.app/) Long-Term Memory into an `AGENTS.md`.**

PiecesOS records what you work on all day. Your coding agent starts every session with none of it.
This CLI reads your memory over MCP and writes the parts that belong to a repository into its
context file, so the next agent already knows why the code looks the way it does.

[![CI](https://github.com/tiagolauer/pieces-to-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagolauer/pieces-to-agents/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pieces-to-agents.svg)](https://www.npmjs.com/package/pieces-to-agents)
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

Run it inside any git repository. There is nothing to install first.

```bash
npx pieces-to-agents
```

The run prints a diff of what it wants to add. Read it, then answer `y` to write the file or
anything else to walk away. Nothing is written until you say so.

## Options

```bash
npx pieces-to-agents --days 30 --target CLAUDE.md --alias ptha --alias "my product"
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

Five things stand between your memory and the file:

1. Nothing is written until you approve a diff. This is the control that actually matters, and
   it has no bypass flag.
2. The personal profile PiecesOS keeps about you, stored as `HIERARCHICAL_PROFILE_SUMMARY`, is
   never read. The tool only reads session summaries and descriptions.
3. A session's own title has to name your project or an alias before any of it is eligible.
   Matching ignores accents, spacing and separators, so `marco-agenda` finds a session titled
   "Marcô Agenda". The title is used rather than the body on purpose: sessions mention other
   projects in passing all the time, and one stray mention used to drag an entire unrelated
   work session into the file.
4. Each bullet has to touch the project's own vocabulary, built from your file and folder
   names, your `package.json` and the aliases you passed. A real session titled "OwlSQL
   Refactoring and Job Search" carries bullets about both, and only the ones anchored to the
   repository survive. Anything Pieces tagged with an identified person is dropped outright.
5. Emails, JWTs, GitHub and Slack tokens and AWS keys are replaced automatically. Names,
   employers and client codenames go in `.pieces-to-agents-ignore`, one per line. A bullet that
   mentions one of those terms is removed entirely rather than masked, because the sentence
   around a name is usually about that name.

Copy `.pieces-to-agents-ignore.example` to get started. The file is git-ignored.

### The diff is a trust boundary

Everything in the generated block came from text that appeared on your screen, and it ends up in a
file your agent treats as instructions. Nothing in between establishes that any of it is
trustworthy.

A web page, a pull request description, a document someone sent you: if PiecesOS saw it, a
summary can quote it, and this tool can copy that quote into the file your agent reads next.
Text written to be obeyed by an agent survives that trip intact. The filters here look for
private data, not for hostile data, and they cannot tell the difference between a decision you
made and a sentence that was written to be found.

So read the diff as though it came from a stranger, because part of it did. This is the same
reason the approval step has no bypass flag.

None of this is airtight. On a real repository with four months of history, these filters took
off-topic bullets from twenty percent of the output down to under four, and the survivors were
mentions of a neighbouring project that shared the same work sessions. Adding that project's name
to the deny-list removed them. Treat the filters as something that makes the diff short enough to
actually read, not as a reason to skip reading it.

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

Nothing here checks whether a memory is true. Pieces writes the summaries with a language model,
and this tool filters and redacts them without verifying anything, so an error in a summary
reaches your file intact. A real run reported a version number with a digit too many. Read the
diff for accuracy as well as for privacy, and put a wrong sentence in the deny-list to drop it.

A wider `--days` fetches more, but not proportionally more, and the result is not monotonic. The
search ceiling is 100 hits per category, and a longer window pulls in older sessions that compete
for the same per-category slots, so a year can surface fewer entries than three months. Try a few
windows rather than assuming the widest is best.

Cancelling exits non-zero, so `pieces-to-agents && something-else` will not run the second command
when you decline the diff.

Project matching reads the session title only. Pieces names sessions after what you worked on,
so this is usually the strongest signal available, but a session with a vague title is dropped
even when its content belongs to your project. `--alias` is the way out, and it takes any name
the session might be titled after.

The bullet filters read English. Something that happened is recognised by an opening past-tense
verb, work still to do by an English imperative, and a title is split on the word "and". PiecesOS
wrote every summary seen during development in English, whatever language the work itself was in,
so this normally costs nothing. If your summaries arrive in another language, every bullet fails
the tense check and the run ends reporting no project match.

## Development

```bash
git clone https://github.com/tiagolauer/pieces-to-agents.git
cd pieces-to-agents
npm install
npm run typecheck
npm test
```

`npm run sync` runs the CLI from source without building. To pass flags, call it through `npx`
instead, because PowerShell swallows the `--` separator that `npm run` needs:

```bash
npx tsx src/cli.ts --days 30 --alias "my product"
```

The tests cover the parts that would fail quietly: splicing the managed block, redaction, the
project and vocabulary filters, composing the output, and parsing an SSE-framed reply.

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
