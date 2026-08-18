import { describe, it, expect } from "vitest";
import { buildCloneInitContainer } from "#src/sandbox/k8s/init-clone.js";

describe("buildCloneInitContainer", () => {
  const c = buildCloneInitContainer("ghcr.io/yo61/lastlight-sandbox:latest", {
    owner: "acme", repo: "web", branch: "feature/x",
    cwd: "/home/agent/workspace", runAsUser: 10001,
  });
  it("runs a restricted-compliant clone init with the repo coordinates", () => {
    expect(c.name).toBe("clone");
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] },
    });
    // Untrusted coordinates travel as argv, not interpolated into the script body.
    expect(c.args).toContain("acme");
    expect(c.args).toContain("web");
    expect(c.args).toContain("feature/x");
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).not.toContain("acme/web");
    expect(scriptText).not.toContain("feature/x");
  });
  it("delivers git auth from env (GIT_CONFIG_* via the creds Secret), never a URL token", () => {
    // The extraheader arrives via envFrom the creds Secret (agentGitIdentityEnv);
    // the script must not interpolate a token into the clone URL.
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).not.toMatch(/x-access-token:/);
  });
  it("guards on an existing checkout via .git and the run marker", () => {
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).toContain(".git"); // guards on an existing checkout
    expect(scriptText).toContain(".lastlight-run"); // run marker distinguishes reuse
  });
  it("passes a malicious branch name as an argv element, never as shell text", () => {
    const evil = "x'; touch /tmp/pwned; echo '";
    const c = buildCloneInitContainer("img", {
      owner: "acme", repo: "web", branch: evil, cwd: "/home/agent/workspace", runAsUser: 10001,
    });
    // The malicious string appears ONLY as a positional arg, never concatenated into the sh -c script.
    expect(c.args).toContain(evil);
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).not.toContain(evil);
    expect(scriptText).not.toContain("touch /tmp/pwned");
  });
});

describe("buildCloneInitContainer reuse refresh (Task 18b)", () => {
  const c = buildCloneInitContainer("img", {
    owner: "acme", repo: "web", branch: "feature/x", baseBranch: "main",
    cwd: "/home/agent/workspace", runAsUser: 10001, runId: "run-123",
  });
  const scriptText = (c.command ?? []).join("\n");

  it("refreshes a reused checkout: fetch head + reset --hard + clean -fdx -e node_modules", () => {
    // A different-run reuse must refresh, not bare-skip (the reported gap).
    expect(scriptText).toMatch(/fetch .*"\$branch"/); // fetch the head ref
    expect(scriptText).toContain("reset --hard");
    expect(scriptText).toContain("clean -fdx -e node_modules"); // keep node_modules warm
  });

  it("preserves a same-run checkout via the .lastlight-run marker (argv run id)", () => {
    expect(scriptText).toContain(".lastlight-run");
    // The run id is compared, never interpolated into the script body.
    expect(c.args).toContain("run-123");
    expect(scriptText).not.toContain("run-123");
  });

  it("fetches + deepens origin/<base> until a shared merge-base (three-dot PR diff)", () => {
    expect(c.args).toContain("main"); // base ref travels as argv
    expect(scriptText).toContain("merge-base");
    expect(scriptText).toMatch(/origin\/\$base/); // base ref name built at runtime
    expect(scriptText).toContain("--unshallow"); // final deepening fallback
    expect(scriptText).not.toContain("main"); // base value never in the script text
  });

  it("clears the harness's scratch files on the refresh path, before the fetch", () => {
    // This backend's half of `resetVerifyScript` / `resetPrNotesJournal`
    // (`engine/executors/shared.ts`), which every other backend does from
    // `prePopulateWorkspace`. The harness has no filesystem access to the PVC,
    // so the init container is the only place that can do it — and it never
    // did, which is issue #256's k8s finding.
    expect(scriptText).toContain("reset_scratch");
    expect(scriptText).toContain('rm -f "$repo_dir/.git/lastlight-verify.sh" "$repo_dir/.git/lastlight-notes"');

    // Ordering: the reset must precede the fetch on the different-run branch,
    // because a FAILED refresh preserves the checkout — and that is exactly the
    // case that must not inherit a superseded diagnosis's gate. `git clean`
    // cannot clear them either; nothing cleans inside `.git/`.
    const lines = scriptText.split("\n");
    const resetAt = lines.findIndex((l) => l.trim() === "reset_scratch");
    const fetchAt = lines.findIndex((l) => l.includes('fetch --depth 50 -- "$url" "$branch"'));
    expect(resetAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(resetAt);
  });

  it("clears them on the fresh-clone path too, so the invariant holds everywhere", () => {
    // A no-op after a real `git clone`, kept so "every path that starts a new
    // run clears the scratch files" is readable off the script rather than
    // reconstructed from which paths could have inherited one.
    const tail = scriptText.slice(scriptText.lastIndexOf('git clone'));
    expect(tail).toContain("reset_scratch");
  });

  it("refreshes origin/<base> on the SAME-run preserve path too, before the early exit", () => {
    // The `#1016` defect, mirrored from the host `prePopulateWorkspace`: the
    // preserve path used to `exit 0` before any fetch, so `origin/<base>` was
    // frozen from the run's FIRST phase and the fix phase merged a base tens of
    // minutes stale — leaving the PR `dirty`, which GitHub cannot build a merge
    // ref for, so no `pull_request` workflow runs at all.
    const lines = scriptText.split("\n");
    const defAt = lines.findIndex((l) => l.trim() === "ensure_base() {");
    const guardAt = lines.findIndex((l) => l.includes('[ "$last_run" = "$run_id" ]'));
    const callAt = lines.findIndex((l, i) => i > guardAt && l.trim() === "ensure_base");
    const exitAt = lines.findIndex((l) => l.includes("(same run) — preserving"));

    expect(defAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(defAt); // the function is defined before it is called
    expect(callAt).toBeGreaterThan(guardAt);
    expect(exitAt).toBeGreaterThan(callAt); // the refresh happens BEFORE `exit 0`
  });

  it("does NOT clear the scratch files on the preserve path (this is not a new run)", () => {
    // The other half of the property: `ensure_base` writes remote-tracking refs
    // only — never HEAD, the index or the working tree — so the uncommitted
    // scratch an earlier phase wrote survives. Adding a `reset_scratch` here
    // would silently drop the live fix-loop push gate mid-run.
    const lines = scriptText.split("\n");
    const guardAt = lines.findIndex((l) => l.includes('[ "$last_run" = "$run_id" ]'));
    const exitAt = lines.findIndex((l) => l.includes("(same run) — preserving"));
    const preserveBlock = lines.slice(guardAt, exitAt + 1).join("\n");
    expect(preserveBlock).toContain("ensure_base");
    expect(preserveBlock).not.toContain("reset_scratch");
  });

  it("adds the base to remote.origin.fetch, so the agent's own `git fetch origin <base>` is load-bearing", () => {
    // `--depth` implies `--single-branch`, so the configured refspec covers the
    // head branch only. Git's opportunistic remote-tracking update then skips
    // `<base>`, and the fix prompt's step-1 `git fetch origin {{baseBranch}}`
    // writes FETCH_HEAD and nothing else — leaving the very next
    // `git merge origin/<base>` on the ref it thought it had just moved.
    expect(scriptText).toContain('remote set-branches --add origin "$base"');
    // `set-branches --add` does NOT dedupe and `ensure_base` runs once per
    // phase, so the configured refspecs are READ first and the add is guarded.
    expect(scriptText).toMatch(
      /config --get-all remote\.origin\.fetch[^\n]*grep -qxF "\$dest"[\s\S]{0,120}remote set-branches --add origin "\$base"/,
    );
    // Best-effort: a second line of defence, never a reason to fail provisioning.
    expect(scriptText).toMatch(/remote set-branches --add origin "\$base" \|\| true/);
  });

  it("keeps the refspec add inside ensure_base's guard (no base / recreate ⇒ untouched)", () => {
    const lines = scriptText.split("\n");
    const defAt = lines.findIndex((l) => l.trim() === "ensure_base() {");
    const guardLineAt = lines.findIndex((l, i) => i > defAt && l.includes('[ "$base" != "$branch" ]'));
    const addAt = lines.findIndex((l) => l.includes("remote set-branches --add origin"));
    const closeAt = lines.findIndex((l, i) => i > defAt && l === "}");
    expect(guardLineAt).toBeGreaterThan(defAt);
    expect(addAt).toBeGreaterThan(guardLineAt); // after `[ -n "$base" ] … || return 0`
    expect(addAt).toBeLessThan(closeAt);
  });

  it("never bare-fetches inside ensure_base — every fetch carries an explicit depth", () => {
    // A bare `git fetch` into a shallow repository has awkward depth semantics
    // and can deepen much further than intended, so the deepening ladder stays
    // explicit: --depth 50 → --depth 500 → --unshallow.
    const lines = scriptText.split("\n");
    const defAt = lines.findIndex((l) => l.trim() === "ensure_base() {");
    const closeAt = lines.findIndex((l, i) => i > defAt && l === "}");
    // `git -C "$repo_dir" fetch …` only — not the `remote.origin.fetch` config read.
    const fetches = lines.slice(defAt, closeAt).filter((l) => /\$repo_dir" fetch /.test(l));
    expect(fetches.length).toBeGreaterThan(0);
    for (const line of fetches) {
      expect(line).toMatch(/--depth "\$depth"|--unshallow/);
    }
  });

  it("recreate-from-base re-clones the default branch and cuts the head locally", () => {
    const rc = buildCloneInitContainer("img", {
      owner: "acme", repo: "web", branch: "lastlight/5-x",
      cwd: "/home/agent/workspace", runAsUser: 10001, runId: "r1", recreateFromBase: true,
    });
    const s = (rc.command ?? []).join("\n");
    expect(rc.args).toContain("1"); // recreate flag delivered as argv "1"
    expect(s).toContain("checkout -B"); // cut the head branch locally off default
  });
});
