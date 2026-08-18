import { describe, it, expect, afterEach } from 'vitest';
import {
  isManagedRepo,
  unmanagedReposInContext,
  getManagedRepos,
  DEFAULT_MANAGED_REPOS,
  setInstallationRepos,
  addInstallationRepos,
  removeInstallationRepos,
  removeInstallation,
  getInstallationRepos,
  getInstallationRepoBreakdown,
  getInstallationReposRefreshedAt,
  getAccessibleManagedRepos,
  resetInstallationReposForTests,
} from '#src/managed-repos.js';
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from '#src/config/config.js';

function configWithRepos(repos: string[]): LastLightConfig {
  return { managedRepos: repos } as unknown as LastLightConfig;
}

describe('DEFAULT_MANAGED_REPOS', () => {
  it('is empty so no deployment-specific repos are baked into the source', () => {
    expect(DEFAULT_MANAGED_REPOS).toEqual([]);
  });
});

describe('getManagedRepos / isManagedRepo', () => {
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it('a non-empty configured list wins and restricts to exactly those repos', () => {
    setRuntimeConfig(configWithRepos(['acme/one', 'acme/two']));
    setInstallationRepos('1', ['other/repo']); // must be ignored while config is set
    expect(getManagedRepos()).toEqual(['acme/one', 'acme/two']);
    expect(isManagedRepo('acme/one')).toBe(true);
    expect(isManagedRepo('acme/two')).toBe(true);
    expect(isManagedRepo('other/repo')).toBe(false);
  });

  it('returns false for an unmanaged repo', () => {
    setRuntimeConfig(configWithRepos(['acme/one']));
    expect(isManagedRepo('unknown/repo')).toBe(false);
  });

  it('falls back to the discovered installation list when the configured list is empty', () => {
    setRuntimeConfig(configWithRepos([]));
    setInstallationRepos('1', ['acme/one', 'acme/two']);
    expect(getManagedRepos().sort()).toEqual(['acme/one', 'acme/two']);
    expect(isManagedRepo('acme/one')).toBe(true);
    expect(isManagedRepo('nope/repo')).toBe(false);
  });

  it('is empty (manages nothing) when neither config nor installation supply repos', () => {
    resetRuntimeConfigForTests();
    expect(getManagedRepos()).toEqual([]);
    expect(isManagedRepo('acme/one')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isManagedRepo(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isManagedRepo(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isManagedRepo('')).toBe(false);
  });
});

describe('getAccessibleManagedRepos (cron fan-out filter)', () => {
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it('drops configured repos the installation can no longer access', () => {
    // e.g. cliftonc/lastlight-test-repo was transferred to nearform — the
    // cliftonc installation no longer lists it, so it must not be scanned.
    setRuntimeConfig(configWithRepos(['acme/live', 'acme/transferred']));
    setInstallationRepos('1', ['acme/live', 'acme/other']);
    expect(getAccessibleManagedRepos()).toEqual(['acme/live']);
  });

  it('returns the configured list unfiltered when installation discovery is empty', () => {
    // Before the boot fetch (or on a fetch failure) we must not drop everything.
    setRuntimeConfig(configWithRepos(['acme/one', 'acme/two']));
    resetInstallationReposForTests();
    expect(getAccessibleManagedRepos()).toEqual(['acme/one', 'acme/two']);
  });

  it('keeps every configured repo when all are accessible', () => {
    setRuntimeConfig(configWithRepos(['acme/one', 'acme/two']));
    setInstallationRepos('1', ['acme/one', 'acme/two', 'acme/three']);
    expect(getAccessibleManagedRepos()).toEqual(['acme/one', 'acme/two']);
  });
});

describe('installation-repo cache', () => {
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it('add/remove mutate the discovered list and the effective managed list', () => {
    setRuntimeConfig(configWithRepos([])); // fall back to installation list
    setInstallationRepos('1', ['acme/one']);
    addInstallationRepos('1', ['acme/two', 'acme/three']);
    expect(getInstallationRepos().sort()).toEqual(['acme/one', 'acme/three', 'acme/two']);
    expect(isManagedRepo('acme/two')).toBe(true);

    removeInstallationRepos('1', ['acme/one']);
    expect(getInstallationRepos().sort()).toEqual(['acme/three', 'acme/two']);
    expect(isManagedRepo('acme/one')).toBe(false);
  });

  it('records a refresh timestamp on every mutation', () => {
    expect(getInstallationReposRefreshedAt()).toBeNull();
    setInstallationRepos('1', ['acme/one']);
    expect(getInstallationReposRefreshedAt()).not.toBeNull();
  });

  it('add before any discovery seeds that installation\'s set', () => {
    resetInstallationReposForTests();
    addInstallationRepos('1', ['acme/one']);
    expect(getInstallationRepos()).toEqual(['acme/one']);
  });
});

/**
 * A GitHub App installed on N accounts gets ONE `installation` event stream per
 * account: `created` lists only the new account's repos, `deleted` means only
 * that account went away. Against a single flat set — what this used to be —
 * installing the App on a second org reset the managed list to just that org,
 * and uninstalling from it cleared the list entirely. Keying by installation id
 * is what makes each account's grant independent.
 */
describe('installation-repo cache — several installations', () => {
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it('unions every installation into the effective list', () => {
    setRuntimeConfig(configWithRepos([]));
    setInstallationRepos('121130978', ['cliftonc/drizby']);
    setInstallationRepos('150854297', ['mirevue/mirevue', 'mirevue/mirevue-www']);

    expect(getInstallationRepos().sort()).toEqual([
      'cliftonc/drizby',
      'mirevue/mirevue',
      'mirevue/mirevue-www',
    ]);
    expect(isManagedRepo('cliftonc/drizby')).toBe(true);
    expect(isManagedRepo('mirevue/mirevue')).toBe(true);
  });

  it('a fresh install on one account leaves the other account alone', () => {
    setRuntimeConfig(configWithRepos([]));
    setInstallationRepos('121130978', ['cliftonc/drizby']);

    // `installation.created` for the second org.
    setInstallationRepos('150854297', ['mirevue/mirevue']);

    expect(isManagedRepo('cliftonc/drizby')).toBe(true);
  });

  it('uninstalling from one account leaves the other account alone', () => {
    setRuntimeConfig(configWithRepos([]));
    setInstallationRepos('121130978', ['cliftonc/drizby']);
    setInstallationRepos('150854297', ['mirevue/mirevue']);

    removeInstallation('150854297');

    expect(getInstallationRepos()).toEqual(['cliftonc/drizby']);
    expect(isManagedRepo('mirevue/mirevue')).toBe(false);
  });

  it('scopes an added/removed repo to its own installation', () => {
    setRuntimeConfig(configWithRepos([]));
    setInstallationRepos('121130978', ['cliftonc/drizby']);
    setInstallationRepos('150854297', ['mirevue/mirevue']);

    addInstallationRepos('150854297', ['mirevue/new']);
    removeInstallationRepos('150854297', ['mirevue/mirevue']);

    expect(getInstallationRepos().sort()).toEqual(['cliftonc/drizby', 'mirevue/new']);
  });

  it('reports a per-installation breakdown for the admin surface', () => {
    setInstallationRepos('121130978', ['cliftonc/drizby']);
    setInstallationRepos('150854297', ['mirevue/mirevue']);

    expect(getInstallationRepoBreakdown()).toEqual([
      { installationId: '121130978', repos: ['cliftonc/drizby'] },
      { installationId: '150854297', repos: ['mirevue/mirevue'] },
    ]);
  });

  it('keeps a configured repo in a second org reachable to the cron fan-out', () => {
    // The drizby/mirevue shape: an explicit `managedRepos` spanning two accounts,
    // narrowed by the union of both installations' grants.
    setRuntimeConfig(configWithRepos(['cliftonc/drizby', 'mirevue/mirevue']));
    setInstallationRepos('121130978', ['cliftonc/drizby']);
    setInstallationRepos('150854297', ['mirevue/mirevue']);

    expect(getAccessibleManagedRepos()).toEqual(['cliftonc/drizby', 'mirevue/mirevue']);
  });
});

describe('unmanagedReposInContext (dispatch guard)', () => {
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it('returns [] for a managed singular repo', () => {
    setRuntimeConfig(configWithRepos(['acme/one', 'acme/two']));
    expect(unmanagedReposInContext({ repo: 'acme/one' })).toEqual([]);
  });

  it('flags an unmanaged singular repo', () => {
    setRuntimeConfig(configWithRepos(['acme/one']));
    expect(unmanagedReposInContext({ repo: 'evil/repo' })).toEqual(['evil/repo']);
  });

  it('returns only the unmanaged entries from a repos[] scan context', () => {
    setRuntimeConfig(configWithRepos(['acme/one', 'acme/two']));
    expect(
      unmanagedReposInContext({ repos: ['acme/one', 'evil/repo', 'acme/two', 'other/x'] }),
    ).toEqual(['evil/repo', 'other/x']);
  });

  it('returns [] when the context carries no repo (e.g. a Slack trigger)', () => {
    setRuntimeConfig(configWithRepos(['acme/one']));
    expect(unmanagedReposInContext({})).toEqual([]);
    expect(unmanagedReposInContext({ repo: '', repos: [] })).toEqual([]);
  });

  it('ignores non-string repo/repos entries', () => {
    setRuntimeConfig(configWithRepos(['acme/one']));
    expect(
      unmanagedReposInContext({ repo: 123, repos: [null, undefined, 'acme/one'] }),
    ).toEqual([]);
  });

  it('honours the installation-list fallback when the configured list is empty', () => {
    setRuntimeConfig(configWithRepos([]));
    setInstallationRepos('1', ['acme/one']);
    expect(unmanagedReposInContext({ repo: 'acme/one' })).toEqual([]);
    expect(unmanagedReposInContext({ repo: 'nope/repo' })).toEqual(['nope/repo']);
  });
});
