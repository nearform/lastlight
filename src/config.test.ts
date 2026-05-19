import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveModel, loadConfig } from './config.js';
import type { ModelConfig } from './config.js';

describe('resolveModel', () => {
  const models: ModelConfig = {
    default: 'openai/gpt-5.3-codex',
    architect: 'openai/gpt-5.4',
    chat: 'openai/gpt-5.4-mini',
  };

  it('returns per-type override when present', () => {
    expect(resolveModel(models, 'architect')).toBe('openai/gpt-5.4');
  });

  it('returns per-type override for chat', () => {
    expect(resolveModel(models, 'chat')).toBe('openai/gpt-5.4-mini');
  });

  it('falls back to default when no override exists', () => {
    expect(resolveModel(models, 'unknown-type')).toBe('openai/gpt-5.3-codex');
  });

  it('falls back to default for empty string type', () => {
    expect(resolveModel(models, '')).toBe('openai/gpt-5.3-codex');
  });
});

// For loadConfig tests we must ensure GITHUB_APP_ID is unset so the
// function doesn't try to require companion GitHub App env vars.

describe('loadConfig — model resolution', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the OpenCode default model when CLAUDE_MODEL not set', () => {
    vi.stubEnv('CLAUDE_MODEL', '');
    const config = loadConfig();
    expect(config.model).toBe('openai/gpt-5.3-codex');
  });

  it('uses CLAUDE_MODEL env var when set', () => {
    vi.stubEnv('CLAUDE_MODEL', 'openai/gpt-5.4');
    const config = loadConfig();
    expect(config.model).toBe('openai/gpt-5.4');
  });
});

describe('loadConfig — model overrides via CLAUDE_MODELS', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns default-only model config when CLAUDE_MODELS not set', () => {
    vi.stubEnv('CLAUDE_MODELS', '');
    vi.stubEnv('CLAUDE_MODEL', '');
    const config = loadConfig();
    expect(config.models.default).toBe('openai/gpt-5.3-codex');
  });

  it('parses valid CLAUDE_MODELS JSON and sets per-type overrides', () => {
    vi.stubEnv('CLAUDE_MODELS', JSON.stringify({ architect: 'openai/gpt-5.4', chat: 'openai/gpt-5.4-mini' }));
    const config = loadConfig();
    expect(config.models.architect).toBe('openai/gpt-5.4');
    expect(config.models.chat).toBe('openai/gpt-5.4-mini');
  });

  it('gracefully handles invalid CLAUDE_MODELS JSON and falls back to defaults', () => {
    vi.stubEnv('CLAUDE_MODELS', 'not-valid-json');
    vi.stubEnv('CLAUDE_MODEL', '');
    const config = loadConfig();
    expect(config.models.default).toBe('openai/gpt-5.3-codex');
  });
});

describe('loadConfig — approval gates', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('approval gates default to empty when APPROVAL_GATES is unset', () => {
    vi.stubEnv('APPROVAL_GATES', '');
    const config = loadConfig();
    expect(config.approval).toEqual({});
  });

  it('parses a comma-separated list of gate names', () => {
    vi.stubEnv('APPROVAL_GATES', 'post_architect,post_reviewer,custom_gate');
    const config = loadConfig();
    expect(config.approval?.post_architect).toBe(true);
    expect(config.approval?.post_reviewer).toBe(true);
    expect(config.approval?.custom_gate).toBe(true);
  });

  it('ignores whitespace and empty entries', () => {
    vi.stubEnv('APPROVAL_GATES', ' post_architect , , post_reviewer ');
    const config = loadConfig();
    expect(Object.keys(config.approval || {}).sort()).toEqual([
      'post_architect',
      'post_reviewer',
    ]);
  });
});

describe('loadConfig — structure', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns a config with expected keys', () => {
    const config = loadConfig();
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('models');
    expect(config).toHaveProperty('stateDir');
    expect(config).toHaveProperty('dbPath');
    expect(config).toHaveProperty('maxTurns');
  });

  it('maxTurns defaults to 200', () => {
    vi.stubEnv('MAX_TURNS', '');
    const config = loadConfig();
    expect(config.maxTurns).toBe(200);
  });
});
