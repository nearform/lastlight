import { describe, it, expect, afterEach } from 'vitest';
import {
  isManagedRepo,
  getManagedRepos,
  DEFAULT_MANAGED_REPOS,
  setInstallationRepos,
  addInstallationRepos,
  removeInstallationRepos,
  getInstallationRepos,
  getInstallationReposRefreshedAt,
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
    setInstallationRepos(['other/repo']); // must be ignored while config is set
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
    setInstallationRepos(['acme/one', 'acme/two']);
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

describe('installation-repo cache', () => {
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it('add/remove mutate the discovered list and the effective managed list', () => {
    setRuntimeConfig(configWithRepos([])); // fall back to installation list
    setInstallationRepos(['acme/one']);
    addInstallationRepos(['acme/two', 'acme/three']);
    expect(getInstallationRepos().sort()).toEqual(['acme/one', 'acme/three', 'acme/two']);
    expect(isManagedRepo('acme/two')).toBe(true);

    removeInstallationRepos(['acme/one']);
    expect(getInstallationRepos().sort()).toEqual(['acme/three', 'acme/two']);
    expect(isManagedRepo('acme/one')).toBe(false);
  });

  it('records a refresh timestamp on every mutation', () => {
    expect(getInstallationReposRefreshedAt()).toBeNull();
    setInstallationRepos(['acme/one']);
    expect(getInstallationReposRefreshedAt()).not.toBeNull();
  });

  it('add before any discovery seeds the list (create-if-null)', () => {
    resetInstallationReposForTests();
    addInstallationRepos(['acme/one']);
    expect(getInstallationRepos()).toEqual(['acme/one']);
  });
});
