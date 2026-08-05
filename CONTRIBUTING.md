# Contributing

Issues and pull requests are welcome. This is a small tool with a narrow job, so the bar for new
behaviour is high and the bar for fixing a leak is low.

## Getting set up

```bash
git clone https://github.com/tiagolauer/pieces-to-agents.git
cd pieces-to-agents
npm install
npm run typecheck
npm test
```

The tests need nothing running. To exercise the tool against real memory you need PiecesOS on
`localhost:39300`, and you have to run from inside a git repository, because the project
vocabulary is read from the current directory:

```bash
npx tsx src/cli.ts --days 30
```

`npm run sync` does the same thing, but PowerShell eats the `--` separator that `npm run` needs
for flags, so call it through `npx` when you want to pass any.

## Where things live

| File | Job |
|---|---|
| `src/cli.ts` | Arguments, orchestration, the diff, the prompt, exit codes |
| `src/mcp.ts` | Talking to PiecesOS, and nothing else |
| `src/memory.ts` | Searching, scoping to a project, normalising what comes back |
| `src/vocabulary.ts` | Deciding whether a line belongs to this repository |
| `src/redact.ts` | Removing secrets, paths and denied terms |
| `src/agents-file.ts` | Composing the block, merging with what is already there, writing |
| `src/core.ts` | Result type, enums, constants |

## What the code follows

Domain failures return a `Result`, never a thrown exception. Every failure mode is an enum member
with its own message and its own exit code. Guard clauses instead of nesting. No `any`; payloads
from PiecesOS arrive as `unknown` and get narrowed at the boundary.

There are no comments. If a piece of code needs one, it usually wants a better name or a smaller
function.

## Tests

Anything that could fail quietly needs a test. That means the filters, the redaction, the splice
into an existing file, and the parsing of anything PiecesOS returns.

Use fictional data in fixtures. Early tests in this repository used a real employer name and a
real client codebase, which had to be scrubbed later. `Jane Doe` and `AcmeCorp` are already in use.

## Changes that touch filtering

The privacy filters are the reason this tool is safe to run, and most of them exist because
something leaked first. If you change one, say in the pull request what leaked, or would have.

Every release that fixed a leak is written up in the CHANGELOG with the cause. That file is worth
reading before changing anything in `redact.ts` or `vocabulary.ts`, because several fixes look
redundant until you know which failure they came from.

## Commits

Explain why the change exists, not what the diff already shows. If a bug had a cause worth
knowing, put it in the message. Write in English.

## Reporting a leak

Do not open a public issue. See [SECURITY.md](SECURITY.md).
