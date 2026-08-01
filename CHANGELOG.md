# Changelog

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
