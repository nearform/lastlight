/**
 * Retry / backoff settings resolution.
 *
 * Pi already auto-retries transient model errors (HTTP 429 rate limits, 503
 * overloaded, 5xx, network/timeout) with exponential backoff, enabled by
 * default. It reads the schedule from a `retry` block in Pi settings.json:
 * `delay = baseDelayMs * 2^(attempt-1)`.
 *
 * Pi's defaults (3 retries, 2000ms base → 2s/4s/8s ≈ 14s total) are too short
 * for providers that rate-limit on a per-minute window — notably Fireworks,
 * whose TPM limits can take ~60s to clear. So agentic-pi raises the defaults
 * to ride out a full window, and exposes `--max-retries` / `--retry-base-delay-ms`
 * to tune per run.
 *
 * Pi 0.87 also caps each agent-level wait at `maxAgentDelayMs` (60s by
 * default), which would silently truncate the final 64s wait below. Unless the
 * operator sets a cap, we raise it to the schedule's own final delay so the
 * schedule above runs as written.
 *
 * Precedence (highest first): CLI flag → operator's settings.json → these
 * defaults. The operator's `retry` block (and any `provider` sub-settings) is
 * layered through unchanged via SettingsManager.applyOverrides() so we never
 * clobber it.
 */

import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@earendil-works/pi-ai";
import type { RetrySettings } from "@earendil-works/pi-coding-agent";

/**
 * 5 retries at a 4000ms base → 4s, 8s, 16s, 32s, 64s. The final wait alone
 * (64s) exceeds Fireworks' ~60s TPM window, so a sustained rate limit clears
 * before the last attempt instead of failing the run.
 */
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 4000;

export interface RetryFlags {
  /** From `--max-retries`. */
  maxRetries?: number;
  /** From `--retry-base-delay-ms`. */
  baseDelayMs?: number;
}

/**
 * Merge CLI flags over the operator's file settings over agentic-pi's defaults.
 * Returns a `retry` object suitable for `SettingsManager.applyOverrides()`.
 * `enabled` and any `provider` sub-settings from the file are preserved.
 */
export function resolveRetrySettings(
  flags: RetryFlags,
  fileRetry: RetrySettings | undefined,
): RetrySettings {
  const f = fileRetry ?? {};
  const maxRetries = flags.maxRetries ?? f.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = flags.baseDelayMs ?? f.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const finalDelayMs = maxRetries > 0 ? baseDelayMs * 2 ** (maxRetries - 1) : 0;
  return {
    ...f,
    enabled: f.enabled ?? true,
    maxRetries,
    baseDelayMs,
    maxAgentDelayMs: f.maxAgentDelayMs ?? Math.max(DEFAULT_MAX_AGENT_RETRY_DELAY_MS, finalDelayMs),
  };
}
