/**
 * Composition of the CHAT system prompt from the live workflow set.
 *
 * The chat agent's answer to "what can you do?" used to be a hand-written string
 * constant listing five triggers. It drifted, in both directions: `verify` and
 * `qa-test` shipped as chat-routable workflows the bot would never mention, and
 * nothing stopped it advertising a workflow an operator had switched off. An
 * overlay that added a workflow got a routable intent for free (issue #164) but
 * no way to be mentioned in chat.
 *
 * So this composes the prompt the same way `assembleClassifier()` composes the
 * classifier prompt: a forkable base template (`workflows/prompts/chat-system.md`)
 * plus one entry per workflow that declares a `chat:` block, cached on the
 * loader's asset version.
 *
 * Two things it must respect that the classifier doesn't:
 *
 *   1. **Opt-in, not derivation.** The gate is the `chat:` block alone —
 *      `classification:` is not consulted. A classification block means "the
 *      classifier can tag a message with this intent", which is not the same as
 *      "a human should be told to type this". See the `chat:` schema doc for the
 *      three workflows where those diverge.
 *   2. **The runtime kill switch.** `listAgentWorkflows()` filters the static
 *      `disabled.workflows` config but knows nothing about the `workflow_overrides`
 *      table an admin toggles from the dashboard (enforced in `simple.ts` at
 *      dispatch). A workflow disabled there would still be advertised, and typing
 *      its trigger would silently no-op. That check is a per-call predicate, not
 *      part of the cached state, because it changes without an asset-version bump.
 *
 * Which is also why the composed suffix is re-derived per chat turn rather than
 * concatenated once at boot — see `ChatRunnerConfig.systemPrompt`.
 */

import { getAssetVersion, listAgentWorkflows, loadPromptTemplate } from "../../workflows/loader.js";
import { RESERVED_CONTROL_INTENTS } from "../../workflows/schema.js";
import { intentOrderIndex } from "../screen/classifier.js";

const BASE_PROMPT_PATH = "prompts/chat-system.md";
const NO_GITHUB_PROMPT_PATH = "prompts/chat-system-no-github.md";

/**
 * The control intents a user can type as a plain chat message. `chat` is the
 * catch-all the router falls back to, not something anyone types, so it is the
 * one reserved intent left off the suggestable list.
 */
const SUGGESTABLE_CONTROL_INTENTS = RESERVED_CONTROL_INTENTS.filter((i) => i !== "chat");

/** One workflow's chat-facing advertisement, flattened out of its YAML. */
interface ChatEntry {
  /** Workflow name — the key the runtime kill switch is checked against. */
  workflow: string;
  /** Phrase the user types. Absent for a deflect-only entry (e.g. repo-health). */
  trigger?: string;
  summary: string;
  deflect?: string[];
  reply?: string;
}

interface ChatPromptState {
  /** Loader asset version this was assembled at, for cheap staleness checks. */
  version: number;
  base: string;
  noGithub: string;
  entries: ChatEntry[];
}

let cachedState: ChatPromptState | undefined;

/** Force a rebuild of the composed prompt (used by tests). */
export function resetChatPromptCache(): void {
  cachedState = undefined;
}

function assemble(): ChatPromptState {
  const entries = listAgentWorkflows()
    .filter((w) => w.chat)
    .sort(
      (a, b) =>
        intentOrderIndex(a.classification?.intent) - intentOrderIndex(b.classification?.intent) ||
        a.name.localeCompare(b.name),
    )
    .map((w) => ({ workflow: w.name, ...w.chat! }));

  return {
    version: getAssetVersion(),
    base: loadPromptTemplate(BASE_PROMPT_PATH),
    noGithub: loadPromptTemplate(NO_GITHUB_PROMPT_PATH),
    entries,
  };
}

function state(): ChatPromptState {
  if (!cachedState || cachedState.version !== getAssetVersion()) {
    cachedState = assemble();
  }
  return cachedState;
}

/**
 * Render one deflection bullet:
 *
 *   - "triage" / "scan issues" / "go through open issues on <repo>"
 *     → reply: "tell me `triage owner/repo`"
 *
 * `deflect` phrases are quoted here rather than in the YAML so authors write
 * bare utterances. A `reply` override lands verbatim after the arrow (continuation
 * lines indented), because naming the trigger isn't always the right answer —
 * `answer` needs the user to add a repo, `repo-health` is cron-only.
 */
function renderBullet(e: ChatEntry): string {
  const phrases = (e.deflect?.length ? e.deflect : [e.summary]).map((p) => `"${p}"`).join(" / ");
  const body = e.reply ?? `reply: "tell me \`${e.trigger}\`"`;
  const [first, ...rest] = body.split("\n");
  const continuation = rest.map((line) => `    ${line.trim()}`);
  return [`- ${phrases}`, `  → ${first}`, ...continuation].join("\n");
}

export interface ChatPromptOptions {
  /**
   * Runtime kill-switch predicate. A workflow an admin disabled in the
   * dashboard is dropped from both rendered lists, so the agent never names a
   * trigger that would no-op at dispatch. Defaults to treating everything as
   * enabled (the shape tests and the evals barrel use).
   *
   * **Deliberately synchronous, and it can no longer be `db.isWorkflowEnabled`
   * itself.** It is applied inside `.filter()` callbacks, three hops down a
   * string-composition expression; making it async would turn this whole
   * module async for the sake of a kill-switch lookup. The caller resolves the
   * enabled set ONCE per turn — one `getAllWorkflowOverrides()` rather than one
   * query per workflow — and closes over it here.
   */
  isWorkflowEnabled?: (workflowName: string) => boolean;
}

/**
 * Select and compose the chat system suffix. With GitHub, advertise the
 * read-only tools + the ENABLED workflow triggers; without it, use the trimmed
 * chat-only prompt so the model never reaches for tools that aren't registered
 * (and never names a workflow trigger, since none of them can run).
 */
export function chatSystemSuffix(hasGithub: boolean, options: ChatPromptOptions = {}): string {
  const { base, noGithub, entries } = state();
  if (!hasGithub) return `\n${noGithub}`;

  const isEnabled = options.isWorkflowEnabled ?? (() => true);
  const live = entries.filter((e) => isEnabled(e.workflow));

  const workflowTriggers = live.map(renderBullet).join("\n");
  const triggerList = [
    ...live.filter((e) => e.trigger).map((e) => `\`${e.trigger}\``),
    ...SUGGESTABLE_CONTROL_INTENTS.map((i) => `\`${i}\``),
  ].join(", ");

  // Function replacers so a `$` in an authored trigger/summary isn't treated as
  // a String.replace special pattern.
  return `\n${base
    .replace("{{workflowTriggers}}", () => workflowTriggers)
    .replace("{{triggerList}}", () => triggerList)}`;
}

/**
 * The chat-facing trigger phrases for the enabled workflow set — the same data
 * the prompt is rendered from. Exposed for the admin surface and tests.
 */
export function chatTriggers(options: ChatPromptOptions = {}): ChatEntry[] {
  const isEnabled = options.isWorkflowEnabled ?? (() => true);
  return state().entries.filter((e) => isEnabled(e.workflow));
}
