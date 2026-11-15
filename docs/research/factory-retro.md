# Factory retrospective: the PR workflow, 14–15 Nov 2026

This is a retrospective on the ticket sessions run since the PR workflow started. It covers 27 lead sessions, from #36 (started 14 Nov 11:44 UTC) to #103 and #107, which were still running at 15 Nov 11:00 UTC. In that time 25 PRs (#82–#97, #111–#115, #130–#134) were opened and merged. All times are UTC.

I was the lead in these sessions, so this is partly a review of my own work.

## Sources and method

- **Claude transcripts** in `~/.claude/projects/*iirc*`: 28 lead sessions, 45 `Agent` builder transcripts, and 10 `delegate_task` Claude children. Token counts come from each assistant message's `usage`, counted once per message id.
- **T3's store** (`statev2.sqlite`, read-only): the 74 Codex review threads, with every command they ran, how long it took, and its output. Each thread also has its final message.
- **GitHub**: each PR's reviews, inline comments, issue comments, and commits, read with `gh api`.
- **The briefs**: the first message of each lead session. All 27 share the same "Roster (v1)" template, and the Uploads tickets add a paragraph about the spec.

Scripts and intermediate output stayed in the session scratchpad and were not committed.

## The numbers

|  | Measured |
| --- | --- |
| Lead sessions / PRs merged | 27 / 25 (#103 and #107 still open) |
| Codex review passes (gpt-6.1-sol, high) | 74 in total: 27 first passes and 47 re-reviews. #44 had 12, #43 had 6, and #78, #47 and #53 had 4 each |
| Codex passes beyond the second for a ticket | 24 (32% of all passes) |
| Codex reviewer wall-clock | 384 min, median 4.4 min per pass, longest 22 min (#44, re-review 10) |
| Commands run by Codex reviewers | 2,098. Of these, 108 were full `vitest` runs, 105 were e2e runs, 64 were `check`, 62 were `knip`, and 271 were probe scripts |
| Codex time spent in suite commands | 374 command-minutes. These overlap with reading, so this is an upper bound on the wall-clock they cost |
| Codex threads where the sandbox broke the test run | 39 of 74 (vitest worker timeouts, `EPERM`, or bind failures) |
| Codex commands that printed the `fnm` multishell error | 1,902 of 2,098 |
| Greptile reviews | 49 across 25 PRs. 12 PRs got 5/5 on the first review with no findings |
| Greptile inline findings | 25 across 14 PRs, 6 of them P1, all raised after Codex had cleared the branch. 24 were fixed and 1 was declined as out of scope (#95, offline `+` Channels) |
| Claude tokens, Opus `Agent` builders | 2.3M output, 784M cache-read, 27.5M cache-write |
| Claude tokens, Sonnet `Agent` builders | 0.5M output, 86M cache-read |
| Claude tokens, leads (Opus, medium) | 1.0M output, 237M cache-read |
| Claude tokens, `delegate_task` Claude builders | 0.3M output, 69M cache-read |
| #44 alone | 349M cache-read: 30% of all Claude cache reads in the period, and 3.5 times the next ticket (#53, 100M) |
| Supervisor messages asking for a rebase | 8, across #44 (2), #48 (2), #45, #53 and #118, plus one asking for `@greptileai review` after a force-push |

## What is working

- **The first Codex pass earns its cost.** 22 of 27 first passes found something the lead then fixed. Many findings were deep and reproduced with probes: on #44, a crash after `Removed` left Credentials in the Vault, and a cancelled request left removal half-applied. Others were #101 (an interrupted write to the store), #102 (S3 writes holding up shutdown), #103 (three blockers), and #118 (fetch-guard gaps). Greptile raised none of this kind of finding later. This is the reviewer working as intended.
- **Greptile is cheap, fast, and catches a different class of bug.** It turned around in minutes. Its 6 P1s were real: a confirmation dialog that could delete a re-added Network (#92), duplicated outgoing messages once a Service login turned echo off (#96), an unsaved Channel that could not be left (#95), and a lost nick refusal on `438` (#115). It also caught the half of a Codex should-fix that the lead's unreviewed fix missed (#100/#114, "held status stays wrong").
- **Tickets as vertical slices worked for most of the queue.** 18 of the 25 PRs went from session start to PR in under 75 minutes, and most merged within 30 minutes of opening.
- **Before-and-after evidence as failing tests.** Replies on Greptile threads name the test that fails without the fix, as in #83, #86, #95, #130 and #134. That makes each fix checkable, and the brief's rule caused it.
- **Leads mostly delegated.** Across 28 lead sessions there were 19 `Edit` and 26 `Write` calls. Where leads did edit, the fixes were small and direct (#100). `SendMessage` reused a builder's context 35 times instead of starting a fresh one.
- **Parallel tickets with disjoint scopes.** #104 ran beside #107, and #103 beside #107. Each brief named the other session and the files to avoid, and those pairs did not collide.

## Findings

### 1. Codex re-reviews ran from scratch and reran the whole suite in a sandbox where it cannot pass

The brief says "every re-review is a fresh run that lists the earlier findings". Leads did what it said. Re-review prompts had a median of 2,756 characters, and only 9 of 74 told the reviewer not to run suites.

Each reviewer starts by reading `AGENTS.md`, which says "Before finishing, run `bun run check`, `bun run knip`, and `bun run test`", plus e2e for Daemon changes. Reviewers obeyed:

- 61 of 74 threads ran the full test suite.
- 40 ran e2e.
- 63 ran `check`.

Codex's sandbox is read-only, has restricted network access, and runs seccomp, so 39 threads hit vitest worker-start timeouts, `EPERM` on subprocess writes, or Daemon bind failures. The reviewer then debugged its own sandbox. On #47 it reran with `--pool=threads`, `--maxWorkers=1` and `node vitest.mjs` in turn. Those reruns are why individual passes ran 10–22 minutes.

Two #44 passes produced no verdict at all. Re-reviews 9 and 10 ended "Vitest workers timed out… no tests ran". Re-review 10 also noted that its "exit 0 came from `tail`".

The same suites had already been run by the builder, by the lead, and by the pre-push hook. The hook (`lefthook.yml`) runs check, knip and test on every push. A reviewer running them a fourth time, in a worse environment, adds noise and no evidence.

Every reviewer command also printed the `fnm` "Can't create the symlink for multishells" error (1,902 of 2,098), because the login shell inits `fnm` in a read-only filesystem. Every reviewer also re-read `AGENTS.md`, `GLOSSARY.md`, `VISION.md` and two review skills on every pass.

### 2. Re-reviews kept finding things, but the long tail was a design problem, not a review problem

Re-reviews were not worthless. By a rough reading of each thread's final message, about 25 of the 47 re-reviews still reported a must-fix. The value fell off by ticket, though:

- **Two passes were enough for most tickets.** Sixteen of the 25 merged tickets finished with two passes or fewer.
- **#44 (Remove a Network) is the outlier.** Its 12 passes ran from 16:56 to 22:24. Passes 4–8 each found new races in the frontend's handling of a Network's "life", and these were introduced by the previous round's fixes. The ticket became 6,863 added lines in 114 files and 19 commits, and took 381 minutes to reach a PR. Greptile then found 3 more P1s and a P2. More review passes were not converging. The ticket needed a design step, or a split into backend removal and frontend reconciliation, after the third round.
- **#43 (mark-read rule) is the second outlier.** It had 6 passes. Two were duplicates: a pass interrupted by Codex's usage limit resumed on an old head while its replacement ran. Several rounds were driven by P2 "should-fix" items.
- **Severity drifted upward.** The brief says "loop until nothing blocks". Leads treated should-fix and P2 findings as reasons for another full pass, as on #36, #43 and #118.
- **Codex's usage limit hit at about 22:08 on 14 Nov,** and reviews on #43 and #44 waited until the reset at 22:18. Concentrating on one provider for the reviewer is the risk that the roster's "spread usage across providers" rationale was meant to avoid.

### 3. Codex and Greptile overlap little, and Greptile is a fine re-reviewer

Every Greptile finding came after Codex had cleared the branch, so each one is a Codex miss on code Codex had seen. The reverse can't be measured, because Codex's findings were fixed before Greptile saw the code.

What each tends to catch:

- **Codex:** lifecycle, durability and cancellation bugs, which it proves with probe scripts. Examples are crash recovery and interrupted writes (#44, #101, #102), and shutdown and stream gaps (#102, #104).
- **Greptile:** interactions with neighbouring features and protocol shapes. Examples are echo-message with Service login (#96), `438` (#115), `CHANTYPES=$` (#111), stale time zones (#130), a quadratic replay (#131), and split-chunk tag leaks (#133). It also caught operational issues, such as a SQL loop that deletes a dropped Network's Messages one id at a time (#92).
- **Both:** the one overlap was #100/#114. Codex flagged it as a should-fix, the lead fixed half of it without a re-review, and Greptile caught the other half.

That last case is the pattern to adopt. Fix small findings without another Codex pass, and let Greptile's automatic review on the PR be the re-review.

### 4. Roster: Opus builders are most of the Claude spend, and some roles went unused

- **Opus builders:** `Agent` builders on Opus took 784M of about 1.18B Claude cache-read tokens (66%) and 2.3M of 4.1M output tokens. Leads took 20%. #44 ran two Opus builders, backend and frontend, for hours, and that ticket alone is 30% of Claude cache reads.
- **Sonnet builders** were used for review fixes, screenshots, one e2e case, and a pure module (#102). I found no case where a Sonnet builder's work had to be redone by Opus. I can't compare quality any further than that from this data.
- **The lead at Opus medium was right for orchestration.** Its spend went mostly to Bash: 1,709 calls across leads, almost all verification, rebasing and PR polling, rather than to thinking.
- **The researcher role** was never used inside a ticket. The research for Uploads and Previews ran on 14 Nov 01:45, before this period, and fed specs #98 and #116.
- **Builder dispatch varied.** Some leads used `Agent` and others `delegate_task` (#47, #101, #103) for the same kind of work. The roster doesn't say which to use, and the transcript shapes differ.

### 5. The same suites ran four or five times per change, and machine load made them flaky

For each change, the full suite ran in the builder, then in the lead, then in the pre-push hook, then in the reviewer. Counting top-level commands:

- **Builders:** 218 full test runs and 58 e2e.
- **Leads:** 99 full test runs, 33 e2e, and 102 `check`.
- **Pushes:** 77 by leads, each of which reran check, knip and test in the hook.

Several sessions ran at once on one machine. Leads recorded flakes "under load average 18" (#40) and 13 times named a flake by hand: `timeline-view`, the property tests, `layout.test.ts`, a web search-view test, and a Playwright `waitFor` in the e2e web suite (#101). Each flake cost a diagnosis ("passes 3/3 alone") and a rerun of the hook, as on #47, #50 and #100.

The failure rates in the transcripts can't be separated from intended TDD reds, so I don't report a flake rate.

### 6. Serial merges caused rebases, and a few files cause most conflicts

PRs merged one at a time, so each open PR had to rebase after each merge. #48 waited 203 minutes from opening to merge and #45 waited 180, mostly for rebases and the Greptile re-reviews that followed. The supervisor asked for 8 rebases.

The conflicts repeat in the same places:

- **The projection version.** It's a global integer that #93 and #95 both bumped, and #95 had to bump it again to 12.
- **Package READMEs** (#44, #45, #53, #102), the `ARCHITECTURE.md` ports table (#118), the shared `api` schemas, and the daemon e2e suite (#53).

On #53 a merge from main reopened all eight conflicts when the branch was later rebased, so the lead squashed it instead.

Permissions and tooling also differed between sessions:

- **Force-pushing:** #102 was denied a force-push and merged main in instead, while #44, #45 and #53 force-pushed with lease.
- **Greptile after a force-push:** Greptile does not re-review after a force-push. The brief says it "re-reviews on each push", so 6 `@greptileai review` comments were posted by hand. One came only after the supervisor noticed 12 idle minutes on #93.

### 7. Evidence and screenshots: each lead reinvented the method

- **Methods differed.** Leads took screenshots by temporarily editing e2e tests (#40, #41, #42), with a throwaway script against MinIO (#104), with a dedicated Opus `delegate_task` session (#61, 20 min), or with a Sonnet `Agent` (#53).
- **Hosting differed.** A gist upload was denied (#41). Other PRs used orphan branches with three naming schemes (`-evidence`, `-screenshots`, or bare SHAs), and that hosting has already rotted. Links by branch name break once the branch is deleted: #92's first image now returns 404, while the SHA-pinned links (#85, #134) still resolve.
- **Lead #53 noted the conflict:** the evidence branch was outside "the ticket branch your brief named".
- **Not every PR needed screenshots.** 13 of 25 PR bodies carry images, and the rest used failing-test evidence, which is cheaper and was just as convincing for non-visual changes.

### 8. Where the brief, AGENTS.md and the skills were unclear, contradictory or ignored

- **The brief's review rules conflict.** The brief requires "a reviewer pass (roster) before publishing" and says to "loop until nothing blocks". It also requires a Greptile loop "until Greptile scores 5/5", with a cap of 4 rounds. The Codex loop has no cap and no definition of "blocks", so should-fix items looped (§2).
- **`AGENTS.md` "Before finishing, run…"** is written for authors, but reviewers read it as applying to them (§1).
- **"Greptile re-reviews on each push"** is false for force-pushes (§6).
- **"Push your ticket branch"** contradicts the evidence branches that the PR rule in practice requires (§7). The brief also never says how to host images.
- **The skills the brief names went unused.** It says to "use the `tdd` / `implement` skills as fits", but `tdd` was invoked 0 times and `implement` is not among this session's skills. Only `pr` was loaded, 25 times, once per PR. Builders still wrote failing-first tests, so the TDD rule was followed without the skill.
- **The roster's dispatch rules are underspecified.** It names Sonnet and Opus builders but not whether to use `Agent` or `delegate_task`, so both were used. "Reviewer: … via T3 delegation" fixes the model but not what the review may run.
- **Two sessions stalled.** At 22:00 on 14 Nov, #43 and #44 needed a "Continue where you left off". The cause is not visible in the transcripts.
- **There is no stop rule for a ticket that grows.** The brief's "stop and report if bigger than it looks" never fired on #44, even at 12 passes and 114 files, because it is only checked at the start.

## A lean default session, and when to escalate

**The default**, for most tickets, such as an option, a command, or a single-package behaviour:

1. **Lead** (Opus, medium): read the ticket, write one self-contained brief, and dispatch one builder with `Agent`. Use Sonnet at high effort when the edit list is known, and Opus at medium only when the design is open.
2. **Builder:** work failing test first. Run focused tests plus `bun run check` while iterating, and run the full suite once at the end.
3. **Lead verification:** run focused tests on the builder's commit, and e2e once if the Transport, Runtime, pacing or Daemon changed. Don't rerun the full suite before pushing: the pre-push hook does that.
4. **One Codex pass** on the final diff. It is read-only, runs no suites, and may run focused tests and probes. It reports blocking findings separately from optional ones.
5. **Fix the blocking findings,** and fix any should-fix the lead agrees with. Don't run a Codex re-review by default.
6. **Push and open the PR.** Greptile's review is the re-review. Answer every finding, and post `@greptileai review` after any force-push. Stop after 3 rounds.
7. **Evidence:** show the failing-before and passing-after test output. Add screenshots only when pixels changed, made with one shared script and linked by SHA.

**Escalate to a heavy session** when the ticket touches durability (the Journal, replay, the Vault), concurrency or cancellation in the Runtime, security boundaries (fetch, Credentials, Uploads), or deletion of the Owner's data. The heavy session runs:

- an Opus builder,
- a second Codex pass limited to the diff of the fixes (`git diff <reviewed>..HEAD`), allowed only when a blocking fix changes lifecycle or concurrency code,
- e2e before the PR.

**Stop and redesign, instead of reviewing again,** when a second Codex pass finds new blocking issues in code written to fix the first. The lead reports to the supervisor with a proposed split or a design note. #44 should have stopped at its third pass.

## Recommendations, ranked

Each saving below is stated as what this period's data says would have been avoided, not as a forecast.

1. **Reviewers run no suites.** Add one line to the reviewer brief: "The lead ran check/knip/test/e2e at `<sha>`; don't run suites; focused tests and probes are fine." Also scope the `AGENTS.md` "Before finishing" rule to authors.
   - **Saving:** the 108 full test runs, 105 e2e runs and 126 check or knip runs in Codex. That is up to 374 command-minutes, most of 39 sandbox-debugging detours, and both of #44's no-verdict passes.
   - **Risk:** low. The hook and the lead already run the suites. A reviewer loses the chance to see a red suite, which it couldn't produce reliably anyway.
2. **One Codex pass by default, plus at most one targeted re-check of the fix diff for lifecycle, concurrency or security blockers. Greptile is the re-review.**
   - **Saving:** this period had 47 re-reviews and 24 passes beyond the second. Under this rule most tickets need one pass, and heavy ones two.
   - **Risk:** medium. Fix-induced bugs move from Codex to Greptile or to after merge. The #100/#114 case shows Greptile catching one. Watch for regressions found after merge and tighten the rule if any appear.
3. **Add a design stop to the brief:** if a second review finds new blocking issues in fix code, stop and report with a proposed split.
   - **Saving:** #44 is the case. Its passes 4–12, two Opus builders running for hours, and 349M cache-read tokens were largely spent converging a design through review.
   - **Risk:** low. It adds a supervisor decision to the loop.
4. **Merge when a PR is green, rebase once just before merge, and take the conflict hotspots out of feature tickets.** Derive the projection version from the code or bump it at merge, give README tables one owner, and allow force-with-lease on ticket branches everywhere.
   - **Saving:** the 8 rebase requests, and the 2–3 hours that #45 and #48 sat open.
   - **Risk:** low to medium. A rebase at merge time can surface a semantic conflict late, so the check run after the rebase must stay.
5. **Make Sonnet the default builder.** Use Opus only for an open design, and let the lead make small review fixes itself.
   - **Saving:** a share of the 784M Opus builder cache-reads. Fix rounds and edit-list work went to Opus even where an edit list was known (#45's "Fix review findings", #104's "Fix Uploads stream resume gap").
   - **Risk:** medium. Sonnet may need more rounds on tasks that look scoped but aren't. I found no Sonnet redo in this period, but the sample is small.
6. **Stop duplicate suite runs, and reduce load flakes.** Builders run the full suite once and leads don't rerun it before push. Cap vitest workers when several sessions run at once, and open issues for the five flaky tests named in §5.
   - **Saving:** a share of the 99 full runs by leads and 218 by builders, and the push retries on #47, #50 and #100.
   - **Risk:** low. The hook still gates every push.
7. **One evidence recipe:**
   - one script that starts the real binary with `--web` and takes named screenshots;
   - images go on a single `evidence` branch and are linked by commit SHA;
   - screenshots are taken only for visual changes, by a Sonnet builder.

   **Saving:** the per-lead reinvention seen in #40, #41, #42, #53, #61 and #104, and broken image links like #92's. **Risk:** low.

8. **Fix the brief template's contradictions:**
   - force-push re-reviews;
   - evidence hosting;
   - the `implement` skill;
   - `Agent` versus `delegate_task`;
   - what "blocks" means: correctness, durability or security, not P2s.

   **Saving:** supervisor interventions like the one on #93, and the over-looping described in §2. **Risk:** none.

9. **Fix the reviewer's shell environment** so that `fnm` does not init in the sandbox, and let reviewers skip re-reading `VISION.md` and `GLOSSARY.md` on a re-check.
   - **Saving:** an error block in 1,902 command outputs, and the context it takes on every Codex command.
   - **Risk:** none.

## What I couldn't measure

- **Codex token totals.** T3 stores only a token snapshot of each thread's last request. Final contexts were about 50k–160k tokens, with cached input over 90% of the input. There is no cumulative count, so I can't say how much of the Codex budget re-reviews used. Pass counts and wall-clock time are the best proxy here.
- **Claude cost in money.** The token counts above are from transcripts, and I didn't price them.
- **What Greptile would have caught of Codex's findings,** since those were fixed before the PR existed.
- **Flake rate.** Failed test runs in transcripts mix intended TDD reds, compound commands and real flakes.
- **The supervisor's own cost and time,** and Dean's merge latency. The supervisor's thread was outside this scope.
- **Quality after merge.** No regression from these PRs has been reported yet, but the period is one day long.
- **Why sessions stalled** at 22:00 on 14 Nov, and how long each lead sat idle waiting on Greptile or Codex. That time is mixed into session wall-clock.
