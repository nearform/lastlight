import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveModel, resolveVariant, loadConfig } from './config.js';
import type { ModelConfig, VariantConfig } from './config.js';

describe('resolveModel', () => {
  const models: ModelConfig = {
    default: 'openai/gpt-5.5',
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
    expect(resolveModel(models, 'unknown-type')).toBe('openai/gpt-5.5');
  });

  it('falls back to default for empty string type', () => {
    expect(resolveModel(models, '')).toBe('openai/gpt-5.5');
  });
});

// For loadConfig tests we must ensure GITHUB_APP_ID is unset so the
// function doesn't try to require companion GitHub App env vars.

describe('loadConfig — model resolution', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    // The dev .env now sets LASTLIGHT_MODEL — clear it so we test the
    // built-in default + legacy OPENCODE_MODEL fallback path.
    vi.stubEnv('LASTLIGHT_MODEL', '');
    vi.stubEnv('LASTLIGHT_MODELS', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the OpenCode default model when OPENCODE_MODEL not set', () => {
    vi.stubEnv('OPENCODE_MODEL', '');
    const config = loadConfig();
    expect(config.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('uses OPENCODE_MODEL env var when set', () => {
    vi.stubEnv('OPENCODE_MODEL', 'openai/gpt-5.4');
    const config = loadConfig();
    expect(config.model).toBe('openai/gpt-5.4');
  });
});

describe('resolveVariant', () => {
  it('returns per-type override when present', () => {
    const variants: VariantConfig = { default: 'medium', architect: 'high', triage: 'minimal' };
    expect(resolveVariant(variants, 'architect')).toBe('high');
    expect(resolveVariant(variants, 'triage')).toBe('minimal');
  });

  it('falls back to default when no override exists', () => {
    const variants: VariantConfig = { default: 'medium', architect: 'high' };
    expect(resolveVariant(variants, 'unknown')).toBe('medium');
  });

  it('returns undefined when neither override nor default is set', () => {
    expect(resolveVariant({}, 'anything')).toBeUndefined();
  });
});

describe('loadConfig — variant overrides via OPENCODE_VARIANTS', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns an empty variants config when nothing is set', () => {
    vi.stubEnv('OPENCODE_VARIANTS', '');
    vi.stubEnv('OPENCODE_VARIANT', '');
    const config = loadConfig();
    expect(config.variants).toEqual({});
  });

  it('parses OPENCODE_VARIANTS JSON and exposes per-type entries', () => {
    vi.stubEnv('OPENCODE_VARIANTS', JSON.stringify({ architect: 'high', reviewer: 'high', triage: 'minimal' }));
    const config = loadConfig();
    expect(config.variants.architect).toBe('high');
    expect(config.variants.reviewer).toBe('high');
    expect(config.variants.triage).toBe('minimal');
  });

  it('uses OPENCODE_VARIANT as the catch-all default', () => {
    vi.stubEnv('OPENCODE_VARIANT', 'medium');
    vi.stubEnv('OPENCODE_VARIANTS', '');
    const config = loadConfig();
    expect(config.variants.default).toBe('medium');
    expect(resolveVariant(config.variants, 'anything')).toBe('medium');
  });

  it('combines default + per-type, with per-type winning', () => {
    vi.stubEnv('OPENCODE_VARIANT', 'medium');
    vi.stubEnv('OPENCODE_VARIANTS', JSON.stringify({ architect: 'high' }));
    const config = loadConfig();
    expect(resolveVariant(config.variants, 'architect')).toBe('high');
    expect(resolveVariant(config.variants, 'triage')).toBe('medium');
  });

  it('gracefully handles invalid OPENCODE_VARIANTS JSON', () => {
    vi.stubEnv('OPENCODE_VARIANTS', 'not-json');
    vi.stubEnv('OPENCODE_VARIANT', '');
    const config = loadConfig();
    expect(config.variants).toEqual({});
  });
});

describe('loadConfig — model overrides via OPENCODE_MODELS', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('LASTLIGHT_MODEL', '');
    vi.stubEnv('LASTLIGHT_MODELS', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns default-only model config when OPENCODE_MODELS not set', () => {
    vi.stubEnv('OPENCODE_MODELS', '');
    vi.stubEnv('OPENCODE_MODEL', '');
    const config = loadConfig();
    expect(config.models.default).toBe('anthropic/claude-sonnet-4-6');
  });

  it('parses valid OPENCODE_MODELS JSON and sets per-type overrides', () => {
    vi.stubEnv('OPENCODE_MODELS', JSON.stringify({ architect: 'openai/gpt-5.4', chat: 'openai/gpt-5.4-mini' }));
    const config = loadConfig();
    expect(config.models.architect).toBe('openai/gpt-5.4');
    expect(config.models.chat).toBe('openai/gpt-5.4-mini');
  });

  it('gracefully handles invalid OPENCODE_MODELS JSON and falls back to defaults', () => {
    vi.stubEnv('OPENCODE_MODELS', 'not-valid-json');
    vi.stubEnv('OPENCODE_MODEL', '');
    const config = loadConfig();
    expect(config.models.default).toBe('anthropic/claude-sonnet-4-6');
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
