import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveModel, resolveVariant, loadConfig } from '#src/config/config.js';
import type { ModelConfig, VariantConfig } from '#src/config/config.js';

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

describe('loadConfig — buildAssets location', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to repo mode with a state-relative store dir', () => {
    vi.stubEnv('LASTLIGHT_BUILD_ASSETS', '');
    const config = loadConfig();
    expect(config.buildAssets).toBe('repo');
    expect(config.buildAssetsDir).toMatch(/build-assets$/);
  });

  it('LASTLIGHT_BUILD_ASSETS=server overrides the file/default location', () => {
    vi.stubEnv('LASTLIGHT_BUILD_ASSETS', 'server');
    const config = loadConfig();
    expect(config.buildAssets).toBe('server');
  });

  it('BUILD_ASSETS_DIR overrides the store directory', () => {
    vi.stubEnv('BUILD_ASSETS_DIR', '/var/lib/lastlight/assets');
    const config = loadConfig();
    expect(config.buildAssetsDir).toBe('/var/lib/lastlight/assets');
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

describe('loadConfig — otel', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('LASTLIGHT_OTEL_ENABLED', '');
    vi.stubEnv('LASTLIGHT_OTEL_SERVICE_NAME', '');
    vi.stubEnv('LASTLIGHT_OTEL_INCLUDE_CONTENT', '');
    vi.stubEnv('LASTLIGHT_OTEL_FORWARD_TO_SANDBOX', '');
    vi.stubEnv('LASTLIGHT_OTEL_STRICT', '');
    vi.stubEnv('LASTLIGHT_OTEL_COLLECTOR_HOSTS', '');
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to disabled metadata-only telemetry', () => {
    const config = loadConfig();
    expect(config.otel).toEqual({
      enabled: false,
      serviceName: 'lastlight',
      includeContent: false,
      forwardToSandbox: true,
      strict: false,
      metrics: true,
      collectorHosts: [],
    });
  });

  it('applies LASTLIGHT_OTEL_* env overrides', () => {
    vi.stubEnv('LASTLIGHT_OTEL_ENABLED', 'true');
    vi.stubEnv('LASTLIGHT_OTEL_INCLUDE_CONTENT', 'true');
    vi.stubEnv('LASTLIGHT_OTEL_FORWARD_TO_SANDBOX', 'false');
    vi.stubEnv('LASTLIGHT_OTEL_STRICT', 'true');
    vi.stubEnv('LASTLIGHT_OTEL_SERVICE_NAME', 'custom-service');
    vi.stubEnv('LASTLIGHT_OTEL_COLLECTOR_HOSTS', 'otel.example.com,https://collector.example.com:4318/v1/traces');
    const config = loadConfig();
    expect(config.otel.enabled).toBe(true);
    expect(config.otel.includeContent).toBe(true);
    expect(config.otel.forwardToSandbox).toBe(false);
    expect(config.otel.strict).toBe(true);
    expect(config.otel.serviceName).toBe('custom-service');
    expect(config.otel.collectorHosts).toEqual(['otel.example.com', 'collector.example.com']);
  });

  it('uses OTEL_SERVICE_NAME but does not auto-enable for OTEL exporter env vars alone', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'env-service');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otel.example.com:4318/v1/traces');
    const config = loadConfig();
    expect(config.otel.enabled).toBe(false);
    expect(config.otel.serviceName).toBe('env-service');
    expect(config.otel.collectorHosts).toEqual(['otel.example.com']);
  });

  it('rejects private/internal OTEL collector hosts from env before sandbox allowlisting', () => {
    vi.stubEnv('LASTLIGHT_OTEL_COLLECTOR_HOSTS', 'https://otel.example.com:4318,http://0.0.0.0:4318,http://[fd00::1]:4318');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://[::1]:4318/v1/traces');
    const config = loadConfig();
    expect(config.otel.collectorHosts).toEqual(['otel.example.com']);
  });
});

describe('loadConfig — provenance and the LASTLIGHT_MODELS/LASTLIGHT_MODEL interaction', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('LASTLIGHT_MODEL', '');
    vi.stubEnv('LASTLIGHT_MODELS', '');
    vi.stubEnv('OPENCODE_MODEL', '');
    vi.stubEnv('OPENCODE_MODELS', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolves models.default once: LASTLIGHT_MODELS.default wins and config.model agrees with it', () => {
    vi.stubEnv('LASTLIGHT_MODEL', 'openai/env-default');
    vi.stubEnv('LASTLIGHT_MODELS', JSON.stringify({ default: 'openai/models-default', architect: 'openai/arch' }));
    const config = loadConfig();
    // The explicit per-task map's `default` key is the single source of truth...
    expect(config.models.default).toBe('openai/models-default');
    // ...and the top-level `model` is derived from it, not re-resolved from LASTLIGHT_MODEL.
    expect(config.model).toBe(config.models.default);
    expect(config.models.architect).toBe('openai/arch');
  });

  it('uses LASTLIGHT_MODEL for models.default when LASTLIGHT_MODELS has no default key', () => {
    vi.stubEnv('LASTLIGHT_MODEL', 'openai/env-default');
    vi.stubEnv('LASTLIGHT_MODELS', JSON.stringify({ architect: 'openai/arch' }));
    const config = loadConfig();
    expect(config.models.default).toBe('openai/env-default');
    expect(config.model).toBe('openai/env-default');
  });

  it('exposes a sources tree where env-supplied values are tagged env and untouched defaults are tagged default', () => {
    vi.stubEnv('LASTLIGHT_MODEL', 'openai/env-default');
    const config = loadConfig();
    const sources = config.publicConfig.sources as Record<string, any>;
    expect(sources.models.default).toBe('env');
    // routes come entirely from the packaged default.yaml
    expect(sources.routes.github.issue_opened).toBe('default');
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

describe('loadConfig — concurrency defaults and env overrides', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('MAX_CONCURRENT_WORKFLOWS', '');
    vi.stubEnv('MAX_QUEUE_WAIT_MS', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('concurrency.maxWorkflows defaults to 4', () => {
    const config = loadConfig();
    expect(config.concurrency.maxWorkflows).toBe(4);
  });

  it('concurrency.maxQueueWaitMs defaults to 3600000 (1 hr)', () => {
    const config = loadConfig();
    expect(config.concurrency.maxQueueWaitMs).toBe(3_600_000);
  });

  it('MAX_CONCURRENT_WORKFLOWS env overrides maxWorkflows', () => {
    vi.stubEnv('MAX_CONCURRENT_WORKFLOWS', '8');
    const config = loadConfig();
    expect(config.concurrency.maxWorkflows).toBe(8);
  });

  it('MAX_QUEUE_WAIT_MS env overrides maxQueueWaitMs', () => {
    vi.stubEnv('MAX_QUEUE_WAIT_MS', '600000');
    const config = loadConfig();
    expect(config.concurrency.maxQueueWaitMs).toBe(600_000);
  });

  it('falls back to default when MAX_CONCURRENT_WORKFLOWS is 0 (invalid)', () => {
    vi.stubEnv('MAX_CONCURRENT_WORKFLOWS', '0');
    const config = loadConfig();
    expect(config.concurrency.maxWorkflows).toBe(4);
  });
});
