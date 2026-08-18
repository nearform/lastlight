/**
 * Which state the dashboard's "my teams' repos" control renders in, pinned per
 * `reason` — and pinned against the SERVER's reason union, so adding a reason
 * to `VisibilityReason` without deciding how the UI answers it fails the build.
 *
 * The control used to be drawn only once real grants resolved, which hid it in
 * exactly the state somebody needs it: they have just created a team or granted
 * it repos, and the answer they need to invalidate is cached for an hour —
 * behind a stale-while-revalidate read, so even waiting out the TTL takes two
 * loads. The re-sync endpoint and the hook's `resync()` both existed; nothing
 * in the SPA ever called them.
 *
 * `scopeControlState` is a pure function for this reason: the mapping is the
 * part that rots, `reason` has nine values, and the dashboard has no React test
 * runner (core's suite imports its plain-TS modules directly, as
 * `dashboard-repo-links.test.ts` does next door).
 */

import { describe, it, expect } from "vitest";
import {
  scopeControlState,
  type ScopeControlState,
} from "../../dashboard/src/hooks/useVisibleRepos.js";
import type { MeRepos } from "../../dashboard/src/api.js";
import type { VisibilityReason } from "#src/engine/github/team-visibility.js";

const answer = (over: Partial<MeRepos> = {}): MeRepos => ({
  repos: null,
  synced: false,
  reason: "no-teams",
  teams: [],
  syncedAt: null,
  ...over,
});

/**
 * Every reason the server can answer with, and the control it should produce.
 * Typed as the SERVER's union — a new `VisibilityReason` is a compile error
 * here until it is given a rendering.
 */
const EXPECTED: Record<VisibilityReason, ScopeControlState> = {
  // The operator's switch is off. The one state a re-sync provably can't fix,
  // because `resync()` short-circuits on it before touching GitHub.
  disabled: "hidden",
  // Everything else is on-but-unresolved: explain it and offer the re-sync.
  "no-teams": "unresolved",
  "no-identity": "unresolved",
  unavailable: "unresolved",
  "too-many-teams": "unresolved",
  truncated: "unresolved",
  budget: "unresolved",
  error: "unresolved",
  // `ok` without repos shouldn't happen, but must not render a filter that
  // would narrow to nothing — see the `available` cases below for the real one.
  ok: "unresolved",
};

describe("scopeControlState — which control each reason renders", () => {
  for (const [reason, expected] of Object.entries(EXPECTED) as Array<
    [VisibilityReason, ScopeControlState]
  >) {
    it(`renders '${expected}' for reason '${reason}'`, () => {
      expect(scopeControlState(answer({ reason }))).toBe(expected);
    });
  }

  it("is 'available' once real grants resolved", () => {
    expect(
      scopeControlState(answer({ reason: "ok", repos: ["nearform/lastlight"], synced: true })),
    ).toBe("available");
  });

  it("is 'hidden' before the first answer lands, not 'unresolved'", () => {
    // Otherwise the control flashes "my teams (none)" on every page load and
    // then rewrites itself — which reads as a failure that fixed itself.
    expect(scopeControlState(null)).toBe("hidden");
  });

  it("stays hidden when the feature is off, even if repos somehow came back", () => {
    // The operator's switch outranks the payload: a stale cached answer must
    // not resurrect the control after the feature is turned off.
    expect(scopeControlState(answer({ reason: "disabled", repos: ["a/b"] }))).toBe("hidden");
  });

  it("treats an empty repo list as unresolved, never as a filter", () => {
    // The server documents `repos` as never `[]` (an empty result is the
    // fail-open `null`). If that ever slipped, filtering to the empty set would
    // blank every view for somebody who can see plenty.
    expect(scopeControlState(answer({ reason: "ok", repos: [], synced: true }))).toBe("unresolved");
  });
});
