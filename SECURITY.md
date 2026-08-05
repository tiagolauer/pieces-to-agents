# Security policy

## What counts as a vulnerability here

This tool exists to move text out of your Long-Term Memory and into a file you commit. The failure
that matters is private data reaching that file when it should not have.

Report privately if you find any of these:

- A filter that can be bypassed, so content reaches the file that the deny-list, the vocabulary
  anchor or the project scope should have removed
- A path where the file is written without an approved diff
- Anything that sends memory off the machine, since every call should go to `localhost:39300`

Ordinary bugs, wrong output, crashes and missing memories go in the public tracker.

## How to report

Use GitHub's private vulnerability reporting on this repository, under the Security tab. That
keeps the report and the discussion private until a fix ships.

Please include what leaked, in terms of category rather than content. "A bullet mentioning a
deny-list term survived" is enough. Do not paste the leaked text itself.

## What to expect

I maintain this alone, so I cannot promise a response time. I will confirm I have seen the report,
say whether I can reproduce it, and tell you when a fix is published. Releases that fix a leak say
so plainly in the CHANGELOG, including the ones caused by my own earlier changes.

## Scope

Supported: the current published version. Older versions on npm are deprecated as soon as a
release fixes something that leaks, so upgrade before reporting.

Out of scope: anything inside PiecesOS itself. Report those to Pieces. If you are unsure which
side a problem sits on, report it here and I will help work it out.

## What this tool cannot protect you from

The filters look for private data, not hostile data. Everything in the generated block came from
text that appeared on your screen, and it lands in a file your agent treats as instructions. A web
page or a document written to be obeyed by an agent survives that trip intact.

Read the diff before approving it. That step exists for this reason and has no bypass flag.
