# Changelog

## 0.1.16

Running the tool a second time replaced the block instead of adding to it, so anything outside the
new window vanished. Come back after a fortnight with the default `--days` and the decisions you
recorded a month ago were gone, with only the diff to warn you. That is a snapshot, and the point
of the file is accumulated context.

Entries already in the file are now kept when the current search does not return them. Each
section still holds four, so an old entry only leaves once four newer ones have pushed it out, and
an entry that comes back again is not duplicated.

## 0.1.15

Project matching compared names with every separator stripped, so a short name could match inside
an unrelated word. A repository called `api` matched a session titled "Rapid prototyping", because
the letters are in there. For a filter whose whole job is keeping other people's work out of your
file, that is the wrong kind of mistake. Matching now compares whole words first, and only falls
back to the run-together form for names of five characters or more, which is what makes `owl sql`
still find "OwlSQL".

A file carrying two managed blocks silently lost one. Only the first pair of markers was
considered, so the second block was orphaned and never updated again. That is now a conflict, the
same as a malformed block.

The target file is read again after you approve, and the block is spliced into whatever is on disk
at that moment. Editing the file by hand while the prompt waits no longer loses the edit.

Cancelling now exits non-zero. It exited zero before, which meant
`pieces-to-agents && git commit` committed after you declined the diff.

The README gained a section saying plainly that the diff is a trust boundary. Everything in the
generated block came from text that appeared on a screen, and it lands in a file an agent treats
as instructions. The filters look for private data, not hostile data.

## 0.1.14

A long window used to fail outright. `annotations_batch_snapshot` accepts at most 100 identifiers,
and a wide search sent more than that, so `--days 365` died every time with a generic call
failure. Batched requests are now split into chunks of 100. The server had been saying exactly
what was wrong, `Array length must be <= 100`, and the client was discarding the message; JSON-RPC
errors now reach the terminal.

Asking for a longer window fetched nothing extra. The search asked for eight hits per category
whatever the window, and the window was applied afterwards, so a bigger `--days` only filtered
less of the same handful. The limit now scales with the window, up to the server's ceiling of 100.

The four category searches ran one after another. They are independent, and running them together
took a real run from 17 seconds to under two.

A summary found only by keyword search carried a score of zero, so the first category in iteration
order always won and everything landed under Architecture decisions. Undecided summaries are now
categorised by which category keyword their own text uses most, and stay undecided if none fits.

When every bullet was filtered out, the error suggested passing `--alias`, which fixes nothing.
That case now has its own message and says that the bullet filters only read English, so summaries
in another language are dropped wholesale.

Adds `--version`. Cancelling no longer prints in red, since it is not a failure.

## 0.1.13

The client advertised `Accept: text/event-stream` but only ever parsed a plain JSON body. The
streamable HTTP transport lets a server frame its answer as an SSE message, and any such reply
collapsed into a generic call failure. When plain parsing fails, the body is now scanned for the
first event whose data payload parses as JSON.

An invalid `--days` fell back to the default instead of stopping. Asking for `--days abc` or
`--days -5` silently used fourteen, which is the kind of quiet substitution this tool is supposed
to refuse. It now exits with its own code.

Colour escapes were written even when stdout was not a terminal, so piping the diff to a file or
another program left the file full of control characters. They are emitted only for a TTY now.

The entry cap counted before rendering, so a category could come up short when an entry was
dropped for having no usable bullets. It applies after rendering.

Two internal cleanups with no behaviour change: the search-hit category is attached once, inside
`searchCategory`, and the accent-folding helper is shared by the matchers rather than duplicated.

The README now says that the bullet filters only read English, which is a real limit for anyone
whose sessions are summarised in another language.

## 0.1.12

Asking for `--help` crashed with a stack trace, because the argument parser threw on any option
it did not know, and that flag is the first thing a new user types. There is now a usage screen
on `--help` and `-h`, and an unknown option exits with its own code and a single line pointing
at the help.

A run whose stdin closed without an answer, piped from a program with nothing to say or started
without a terminal at all, hung forever at the confirmation prompt. End of input now reads as a
no, and the run cancels.

The client version sent in the MCP handshake was a hand-copied constant, one release away from
drifting apart from the package. It is now read from `package.json` at runtime.

When both searches found the same summary, the keyword hit always decided its category, because
full-text matches carried the highest possible score. A semantic match now outranks a keyword
hit, which only vouches for recall.

CI now runs the build that only publishing exercised before, and the package page on npm links
back to the repository, its issues and its author.

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
