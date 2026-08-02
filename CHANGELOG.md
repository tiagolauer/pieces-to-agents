# Changelog

## 0.1.11

Summaries link concepts back into Pieces with a `pieces://` target. Stripping the target left the
markdown label stranded, so a sentence about the compiler read `handle [TypeScript] 7.0 API
changes`. Such a link now collapses to its label, and any bracket left without a target is
unwrapped. The placeholders this tool writes are listed in one place so unwrapping never touches
them.

Also states plainly in the README that nothing here checks whether a memory is true. Summaries are
written by a language model, and an error in one reaches your file intact. A real run reported a
version number with a digit too many.

## 0.1.10

A failed run used to report only that a call to the MCP server had failed. The client now names
the tool it was calling, reports the HTTP status when PiecesOS refuses, and separates a timeout,
which usually means indexing is in progress and the run should simply be repeated.

Notes in the README that `npm run sync` cannot take flags under PowerShell, which consumes the
`--` separator before npm sees it.

## 0.1.9

Two kinds of line still reached the output. Bullets that were plain noun phrases, a list of pages
visited or a file path with a parenthetical. And titles whose unrelated half anchored on a generic
folder name, so `OwlSQL Audit and Whisper Integration` survived because the repository has an
integration test folder.

Tense separates memory from the rest. Something that happened is written in the past, a task still
open is written as an imperative, and a reference is a noun phrase. Bullets now have to open with
a past tense verb, allowing a leading "You" or "We". The generic term list grew to cover
`integration`, `fixtures`, `examples`, `helpers` and similar names that were anchoring unrelated
sentences.

## 0.1.8

Session titles announced unrelated work, so a heading read `OwlSQL Refactoring and Job Search`. A
title is now trimmed to the halves that touch the project vocabulary, keeping the whole title when
no half does.

Bullets describing work still to do were being recorded as memory. A context file that lists
yesterday's intentions ages badly and reads to an agent as an open task list, so bullets that open
with an imperative are dropped. Bullets that survived redaction as nothing but a placeholder are
dropped too.

The confirmation prompt counted memories before rendering, so it offered to write thirteen and
produced nine. It now counts what the block actually contains.

## 0.1.7

A run leaked a third party name alongside an international phone number, and a file link whose
target had been replaced left broken markdown behind. Phone numbers in international and Brazilian
formats are now replaced, and a markdown link pointing at something scrubbed collapses to its text.

## 0.1.6

The target was matched against the exact string `CLAUDE.md`, so anything else quietly became
`AGENTS.md`. Asking for `--target claude.md` wrote the wrong file and said nothing. Matching now
ignores case and an optional `.md`, and anything that is neither file is an error with its own
exit code.

## 0.1.5

Session titles went straight into the output without passing any filter, so a denied term reached
the file through the heading even though every bullet under it was clean. A real run produced
`OwlSQL Auditing and Hostinger Troubleshooting` with Hostinger already on the deny-list. Titles
now go through the same redaction as bullets.

## 0.1.4

Running the tool on its own repository surfaced four defects.

The deny-list masked terms instead of dropping bullets, because redaction ran before the filter
saw them. A bullet about the LICENSE file survived as "[redacted] Lauer". Redaction now runs last,
on bullets that already passed every filter.

Absolute paths reached the output and exposed the machine's directory layout, client folder names
included. Windows drive paths, POSIX home paths and `file://` URIs are replaced, and folder names
containing spaces no longer leave a trailing fragment behind.

The email pattern matched package coordinates, so `pieces-to-agents@0.1.0` became a placeholder
mid-sentence. It now requires an alphabetic top level domain.

Bullets that are nothing but a markdown link are dropped.

## 0.1.3

Filters memory at the bullet instead of the session.

Scoping by session title in 0.1.1 was not enough. Real sessions cover more than one thing, and a
title like "OwlSQL Refactoring and Job Search" let an entire mixed session through. On a repository
with four months of history, one in five bullets belonged to something else: job listings, a
neighbouring project owned by someone else, hosting support for unrelated client domains, and
gameplay.

Every bullet now has to touch the project's own vocabulary, gathered from file and folder names,
`package.json` and the aliases passed on the command line. Bullets that Pieces tagged with an
identified person are dropped whatever else they say, and `pieces://` links no longer reach the
file. Deny-list terms now remove the entire bullet rather than masking the word, because the
sentence around a name is usually about that name.

The same repository went from eleven off-topic bullets to two, both naming a project that shares
work sessions with it. Adding that name to `.pieces-to-agents-ignore` cleared them.

## 0.1.2

Removes a UTF-8 byte order mark from `package.json` and `src/core.ts`. Node reads a BOM at the
start of `package.json` as invalid JSON, which broke module resolution on Node 20.11. CI now
rejects any tracked file that starts with one.

## 0.1.1

Fixes a scoping bug that could leak unrelated work into the generated file.

Eligibility used to be decided by searching the whole session, title and body together. Work
sessions mention other projects constantly, so a single passing reference was enough to pull an
entire unrelated session in. A real run on a client repository pulled in a salary negotiation, a
third party's code audit, and account recovery details, all because one line listed the project
name among several others.

Eligibility now reads the session title only, which is what Pieces names after the work you
actually did. Matching folds away accents, spacing and separators, so `marco-agenda` still finds
a session titled "Marcô Agenda".

If you ran 0.1.0, re-read any `AGENTS.md` it produced before pushing it anywhere.

## 0.1.0

First release.
