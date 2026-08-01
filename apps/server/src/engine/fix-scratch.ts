/**
 * The two files the harness owns inside a PR checkout — the fix loop's push
 * gate and the PR journal — and the one argument that places both.
 *
 * ## They live under `.git/`, and that is the guarantee
 *
 * `.git/` is the repository, not the work tree. No pathspec walk enters it, so
 * `git add -A`, `git add .` and `git commit -a` cannot see either file — on
 * every backend, in every `buildAssets` mode, with nothing to register
 * anywhere. That last clause is the point.
 *
 * Both files used to sit at the ROOT OF THE CHECKOUT and stay out of the pull
 * request because each backend added them to the checkout's local
 * `.git/info/exclude`. The kubernetes backend never got that code, so on k8s
 * the harness's own scratch files were committed into the dependency PR by the
 * agent's `git add -A` (issue #256). A guarantee that every new backend has to
 * re-implement is not a guarantee; a path git structurally cannot reach is.
 * The failure mode of a backend forgetting is now a STALE GATE, which is
 * recoverable and locally visible, rather than a COMMITTED FILE, which is
 * neither.
 *
 * ## Why not a sibling of the checkout
 *
 * gondolin is the packaged default (`sandbox.backend: gondolin`) and mounts
 * only cwd, so a workspace-root sibling reached via `../` is unreachable inside
 * the guest — the gate would silently never run and the journal would silently
 * never be written on the default backend. `.git/` is inside cwd, so it is
 * reachable there. (This is also why `artifactIssueDir`'s relocation could not
 * be reused: it is conditional on `buildAssets === "server"` AND a non-gondolin
 * backend, and these two must be placed correctly everywhere.)
 *
 * ## Why one uniform path
 *
 * The prompts state a bare relative path with the agent's cwd already the
 * checkout, and the harness resolves the same path from the run row. Neither
 * has to know the backend. It also keeps `generic_loop.until_bash` a LITERAL
 * string, which the engine's `validateShellCommand` requires — it rejects any
 * command containing `{{`, so the gate path cannot be templated per backend.
 * `tests/workflows/pr-fix.test.ts` pins the YAML literal to
 * {@link VERIFY_SCRIPT_NAME} so the two cannot drift.
 *
 * ## What still has to happen per run
 *
 * `git clean -fdx` does not enter `.git/` either, so the explicit deletes in
 * `./executors/shared.ts` (`resetVerifyScript`, `resetPrNotesJournal`) are the
 * ONLY thing that clears a file an earlier attempt left behind. On the
 * kubernetes backend the harness has no filesystem access to the PVC, so the
 * clone init container does it instead (`../sandbox/k8s/init-clone.ts`).
 *
 * Pure: two strings and no I/O, so the pure decision modules
 * (`./pr-decisions.ts`, `./pr-notes.ts`) can project them onto the prompt
 * context without importing the executor layer.
 */

/**
 * The within-run push gate (04-retry.md §4.5, 09-state-machine.md §S1).
 *
 * The right gate command is not statically knowable — the package manager comes
 * from the lockfile and the commands from the repo's own CI workflow — so
 * `skills/fixing/SKILL.md` has the agent write it here, and the fix loop runs
 * it through `generic_loop.until_bash`; exit 0 ends the loop.
 *
 * A STALE gate is worse than no gate: it passes green against the wrong
 * commands and authorises a push. That is what `resetVerifyScript` exists for,
 * and it matters because the fix FAMILY shares ONE workspace per PR (§S4) — a
 * gate written by a superseded diagnosis, possibly by the *other* fix workflow,
 * outlives the run that wrote it.
 */
export const VERIFY_SCRIPT_NAME = ".git/lastlight-verify.sh";

/**
 * The PR journal — the agent's outbox for `PrState.notes` (10-pr-memory.md).
 *
 * Drained into the run's scratch at the end of every phase (`./fix-harvest.ts`
 * → `drainPrNotes`), so its durable home is the snapshot; the file itself is a
 * per-phase outbox, never an accumulator.
 */
export const PR_NOTES_FILE_NAME = ".git/lastlight-notes";
