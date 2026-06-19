# Architect Plan — Issue #96

## Problem Statement

`src/engine/llm.ts:34-47` exposes `callLlm(model, systemPrompt, userPrompt)` but immediately fans out to three near-identical private provider functions, `callAnthropic`, `callOpenai`, and `callOpenrouter` at `src/engine/llm.ts:141-255`; each repeats the same fetch/check/parse/extract structure. Provider/key precedence currently lives in `defaultFastModel()` at `src/engine/llm.ts:91-105`, while provider-specific API key lookup is duplicated in each adapter at `src/engine/llm.ts:148`, `src/engine/llm.ts:183`, and `src/engine/llm.ts:227`. The two consumers dynamically import this module and choose defaults internally (`src/engine/screen.ts:53-60`, `src/engine/classifier.ts:152-158`), so their dependency on the LLM helper is hidden and unit tests cannot stub chat without module/env manipulation.

## Summary of what needs to change

Introduce one provider-agnostic `chat(model, messages, opts?)` seam in `src/engine/llm.ts` that resolves provider routing, API key selection, request construction, retry/timeout, response validation, and text extraction through one adapter table. Centralize provider precedence in the same provider registry that `defaultFastModel()` uses, so adding a provider updates exactly one list. Refactor `screen.ts` and `classifier.ts` so callers can inject `chat` and default-model selection, while default production calls still use the real helper. Expand unit coverage for the new seam and add stubbed-chat tests for screener/classifier.

## Files to modify — exhaustive manifest

### `src/engine/llm.ts`

- Anchor `CallLlmOptions` at `src/engine/llm.ts:22-27`:
  - Rename/export as `ChatOptions` or keep `CallLlmOptions` as a compatibility alias; include `maxTokens?: number` and `timeoutMs?: number`.
  - Add exported types:
    - `export type ChatRole = "system" | "user" | "assistant";`
    - `export interface ChatMessage { role: ChatRole; content: string; }`
    - `export type ChatFunction = (model: string, messages: ChatMessage[], opts?: ChatOptions) => Promise<string>;`
    - `type ProviderName = "anthropic" | "openai" | "openrouter";`
- Anchor `callLlm` at `src/engine/llm.ts:34-47`:
  - Replace the fan-out body with a new exported `chat(model, messages, opts = {})` function.
  - Keep `callLlm(model, systemPrompt, userPrompt, opts?)` only as a thin compatibility wrapper around `chat(model, [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], opts)` if desired; do not keep any provider-specific logic in `callLlm`.
  - Ensure retry/timeout remains in `withRetry()` at `src/engine/llm.ts:57-77`, but update the unreachable error string if the public function is renamed.
- Anchor `defaultFastModel()` at `src/engine/llm.ts:91-105`:
  - Remove hard-coded `hasAnthropic`/`hasOpenai`/`hasOpenrouter` booleans.
  - Add a single ordered provider registry near `resolveProvider`, e.g. `const PROVIDERS: ProviderAdapter[] = [...]`, ordered `anthropic`, `openai`, `openrouter`.
  - Each adapter must declare `name`, `prefix`, `envKey`, `defaultModel`, `resolveModelId`, `buildRequest`, and `extractText` or equivalent.
  - Implement `defaultFastModel(taskType?)` by first honoring `readOpencodeModelOverride(taskType)`, then iterating the ordered registry and returning the first adapter whose `process.env[adapter.envKey]` is set, finally falling back to the OpenAI adapter default. This makes precedence live in the registry order only.
- Anchor `resolveProvider()` at `src/engine/llm.ts:119-139`:
  - Keep it exported for tests, but implement it by consulting the same registry instead of hard-coded `if` branches.
  - Preserve current behavior: explicit `anthropic/`, `openai/`, and nested `openrouter/<vendor>/<model>` are supported; unsupported explicit prefixes throw; unprefixed `claude*` routes to Anthropic and all other bare ids route to OpenAI.
- Anchor private provider calls at `src/engine/llm.ts:141-255`:
  - Delete `callAnthropic`, `callOpenai`, and `callOpenrouter` entirely.
  - Replace them with provider adapter request builders and extractors used only by `chat()`.
  - The common `chat()` implementation should do exactly one fetch/check/parse/extract path:
    1. Resolve `{ provider, modelId }`.
    2. Look up the adapter.
    3. Read the API key through one helper, e.g. `apiKeyFor(adapter)` that throws `${adapter.envKey} not set`.
    4. Build request URL/init via the adapter.
    5. `fetch()`, check `res.ok`, parse JSON once, and call `adapter.extractText(data)`.
  - Preserve provider-specific request schemas:
    - Anthropic endpoint `https://api.anthropic.com/v1/messages`, headers `x-api-key` and `anthropic-version`, body `system` from system messages, `messages` excluding system messages, and `max_tokens`.
    - OpenAI endpoint `https://api.openai.com/v1/chat/completions`, bearer auth, body `messages`, and `max_completion_tokens`.
    - OpenRouter endpoint `https://openrouter.ai/api/v1/chat/completions`, bearer auth plus `HTTP-Referer`/`X-Title`, body `messages`, and `max_tokens`.
  - Preserve text extraction semantics: Anthropic concatenates `content` blocks with `{ type: "text", text }`; OpenAI/OpenRouter return `choices[0].message.content ?? ""`.

### `src/engine/screen.ts`

- Anchor `ScreenResult` at `src/engine/screen.ts:37-40`:
  - Add an exported dependency/options interface, e.g. `export interface ScreenForInjectionOptions { model?: string; chat?: ChatFunction; defaultFastModel?: (taskType?: string) => string; }`.
  - Import `type ChatFunction` from `./llm.js` at the top as a type-only import.
- Anchor `screenForInjection()` signature at `src/engine/screen.ts:47-50`:
  - Change signature to `screenForInjection(text: string, options: ScreenForInjectionOptions = {})`.
  - If backwards compatibility for direct model strings is important, support an overload or `string | ScreenForInjectionOptions`, but keep the new object form for tests.
- Anchor dynamic import/call at `src/engine/screen.ts:53-60`:
  - Remove the dynamic import inside the function.
  - Use injected dependencies: `const chat = options.chat ?? realChat; const defaultFastModel = options.defaultFastModel ?? realDefaultFastModel;` where `realChat`/`realDefaultFastModel` are normal module imports from `./llm.js`.
  - Call `chat(options.model ?? defaultFastModel("screener"), [{ role: "system", content: SCREENER_PROMPT }, { role: "user", content: `Screen this text:\n\n${text}` }], { maxTokens: 64 })`.
  - Preserve current short-circuit (`src/engine/screen.ts:51`) and fail-open catch behavior (`src/engine/screen.ts:73-77`).

### `src/engine/classifier.ts`

- Anchor `ClassifierContext` at `src/engine/classifier.ts:31-37`:
  - Add an exported dependency/options interface, e.g. `export interface ClassifierOptions { model?: string; chat?: ChatFunction; defaultFastModel?: (taskType?: string) => string; }`.
  - Import `type ChatFunction` plus real `chat`/`defaultFastModel` from `./llm.js` at the top.
- Anchor `classifyComment()` signature at `src/engine/classifier.ts:142-146`:
  - Change the third parameter from `model?: string` to `options: ClassifierOptions = {}` (or support `string | ClassifierOptions` for backward compatibility).
- Anchor dynamic import/call at `src/engine/classifier.ts:152-158`:
  - Remove the dynamic import.
  - Use injected `chat`/`defaultFastModel` dependencies with real defaults.
  - Call `chat(options.model ?? defaultFastModel("classifier"), [{ role: "system", content: CLASSIFIER_PROMPT }, { role: "user", content: userPrompt }], { maxTokens: 128 })`.
  - Preserve all parsing logic from `src/engine/classifier.ts:160-204` and fail-safe `intent: "chat"` catch from `src/engine/classifier.ts:205-208`.

### `src/engine/llm.test.ts`

- Anchor import at `src/engine/llm.test.ts:1-2`:
  - Import `chat` instead of (or in addition to) `callLlm`; keep `defaultFastModel` and `resolveProvider`.
- Anchor `resolveProvider` tests at `src/engine/llm.test.ts:4-26`:
  - Keep all existing cases and ensure they pass through registry-backed resolution.
  - Add/keep explicit coverage for `anthropic/`, `openai/`, and `openrouter/` model ids per acceptance criteria.
- Anchor `defaultFastModel` tests at `src/engine/llm.test.ts:28-76`:
  - Keep existing env precedence tests.
  - Add a test that when Anthropic, OpenAI, and OpenRouter keys are all set, the first registry entry wins (`anthropic/`), documenting single-place precedence.
- Anchor provider-call tests at `src/engine/llm.test.ts:78-200`:
  - Rename the describe block to `chat`.
  - Update calls from `callLlm(model, "sys", "user")` to `chat(model, [{ role: "system", content: "sys" }, { role: "user", content: "user" }])`.
  - Keep assertions for endpoints, headers, request bodies, text extraction, missing API key errors, retry on 429/5xx, and no retry on deterministic 400.
  - Add a focused test that `callLlm`, if retained, delegates to `chat` behavior or at least produces equivalent output; do not depend on private provider functions.

### `src/engine/screen.test.ts`

- Anchor import at `src/engine/screen.test.ts:1-8`:
  - Add `vi` to the Vitest import if needed for stub functions.
- Anchor short-circuit tests at `src/engine/screen.test.ts:55-65`:
  - Update them to pass a stub `chat` and assert it was not called for empty/short input.
- Add a new describe block after `src/engine/screen.test.ts:65`:
  - `screenForInjection — injected chat`.
  - Test positive parse: stub `chat` returns `INJECTION: YES\nREASON: override attempt`; call `screenForInjection(longText, { chat: stub, defaultFastModel: () => "openai/test" })`; assert `{ flagged: true, reason: "override attempt" }`, assert stub called once with model `openai/test`, two messages (system prompt + user prompt), and `{ maxTokens: 64 }`.
  - Test negative parse: stub returns `INJECTION: NO\nREASON: NONE`; assert `{ flagged: false }`.
  - Test fail-open: stub rejects; assert `{ flagged: false }` and, if console noise is undesirable, spy/mock `console.error` for the test.
  - These tests must not set or delete `process.env` and must not mock dynamic imports.

### `src/engine/classifier.test.ts`

- Anchor import at `src/engine/classifier.test.ts:1-2`:
  - Add `vi` to the Vitest import.
  - Import `classifyComment` in addition to `extractGithubRefFromText`.
- Add a new describe block after existing `extractGithubRefFromText` tests (`src/engine/classifier.test.ts:77`):
  - `classifyComment — injected chat`.
  - Test build parse: stub `chat` returns `INTENT: BUILD\nREPO: cliftonc/lastlight\nISSUE: 96\nREASON: NONE`; call `classifyComment("@last-light can you build this?", { issueTitle: "Introduce one provider-agnostic chat() seam" }, { chat: stub, defaultFastModel: () => "openai/test" })`; assert intent/repo/issue, and assert stub called with model `openai/test`, two messages, and `{ maxTokens: 128 }`.
  - Test URL fallback still works with stub output missing repo: stub returns `INTENT: SECURITY\nREPO: NONE\nISSUE: NONE\nREASON: NONE`; input contains `https://github.com/foo/bar/pull/7`; assert repo `foo/bar` and issue `7`.
  - Test error fallback: stub rejects; assert `{ intent: "chat" }` and spy/mock `console.error` to avoid noisy output.
  - These tests must not set/delete `process.env`.

## Commands

`./.lastlight/issue-96/guardrails-report.md` is not present in this checkout, so there were no issue-specific guardrail commands to copy verbatim. Use the repo-documented commands from `CLAUDE.md`/`package.json` for executor verification:

```bash
npm run build
npx vitest run
cd dashboard && npx tsc -b
```

Recommended focused loop before the full suite:

```bash
npx vitest run src/engine/llm.test.ts src/engine/screen.test.ts src/engine/classifier.test.ts
```

## Implementation approach

1. In `src/engine/llm.ts`, define the public `ChatMessage`, `ChatOptions`, and `ChatFunction` types and a single ordered provider registry for `anthropic`, `openai`, and `openrouter`.
2. Implement `chat(model, messages, opts?)` as the only function that does provider dispatch, API key lookup, common retry/timeout, fetch, non-2xx error handling, JSON parsing, and provider-specific extraction.
3. Rewrite `defaultFastModel()` and `resolveProvider()` to consult the registry rather than hard-coded parallel conditionals. Preserve current model routing and error messages as much as possible.
4. Delete private `callAnthropic`, `callOpenai`, and `callOpenrouter`; move their unique request/response details into provider adapter fields/functions.
5. Optionally keep `callLlm()` as a compatibility wrapper around `chat()` for any external imports, but do not use it from screener/classifier and do not leave provider logic there.
6. Refactor `screenForInjection()` to accept injectable `{ chat, defaultFastModel, model }` options and use normal imports for production defaults.
7. Refactor `classifyComment()` similarly, keeping all output parsing and fallback behavior intact.
8. Update `llm.test.ts` to exercise `chat()` and registry-backed provider/default behavior for Anthropic, OpenAI, and OpenRouter.
9. Add stubbed-chat unit tests in `screen.test.ts` and `classifier.test.ts` that prove both modules can be tested without network or `process.env` setup.
10. Run the focused Vitest command, then the full build/test/typecheck commands listed above.

## Risks and edge cases

- Anthropic uses a different wire format from OpenAI/OpenRouter; converting generic messages must preserve the existing `system` field and user content behavior. If multiple system messages are supplied, concatenate them with newlines or choose a clear deterministic rule.
- OpenRouter must continue using `max_tokens`, not OpenAI's `max_completion_tokens`; mixing these will break non-OpenAI routed models.
- Provider precedence should not be duplicated in tests or helper logic; only registry order should decide `defaultFastModel()` when multiple API keys are present.
- Existing call sites currently pass only `(text)` and `(commentBody, context)`; changing function signatures must remain backwards-compatible for these production callers.
- Error text is used by retry detection (`429|5xx` in message). Preserve status codes in thrown non-2xx errors.
- Keeping `callLlm()` as a wrapper may be safer for downstream imports, but acceptance requires the three near-identical provider functions to be gone; do not leave old private functions in place.

## Test strategy

- Unit-test `resolveProvider()` and `defaultFastModel()` to ensure registry-backed routing and precedence for `anthropic/`, `openai/`, and `openrouter/`.
- Unit-test `chat()` with mocked `globalThis.fetch` for each provider: correct URL, headers, model id transformation, token field, message body, and text extraction.
- Unit-test retry behavior on transient 429/5xx and no retry on deterministic 400.
- Unit-test `screenForInjection()` with injected stub `chat` for positive, negative, short-circuit, and fail-open cases; no env mutation.
- Unit-test `classifyComment()` with injected stub `chat` for intent parsing, GitHub URL fallback, and fail-safe error behavior; no env mutation.
- Run full TypeScript build and Vitest suite, plus dashboard typecheck for repository guardrails.

## Estimated complexity

Medium.
