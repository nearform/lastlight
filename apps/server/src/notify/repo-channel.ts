/**
 * Which Slack channel a repo's outbound notifications go to.
 *
 * Three answers, most specific first:
 *
 *   1. the repo's own `.lastlight/lastlight.yml` → `notifications.slack.channel`
 *   2. the operator's `slack.repoChannels["owner/repo"]` (overlay config.yaml)
 *   3. the global `slack.deliveryChannel` (`SLACK_DELIVERY_CHANNEL`)
 *
 * And a fourth outcome that is not a fallback: **undefined**, meaning this repo
 * gets nothing. That is the default state of a fresh install and it is load
 * bearing — a deployment that has configured no channel must not start posting
 * into whichever workspace the bot happens to be in.
 *
 * ## Why a repo is trusted to name its own channel
 *
 * Every other repo-settable key is clamped so a repo can only be MORE
 * conservative than the operator. A channel has no such ordering, so the repo's
 * value simply wins. Two things make that safe, and neither is a bound:
 *
 * - The layer is **always read from the repo's default branch** (the standing
 *   trust rule of the repo-config layer), so a pull request cannot redirect the
 *   output of the agent reviewing it.
 * - Slack will not deliver to a channel the bot has not been invited to. The
 *   worst a hostile `.lastlight/` achieves is `channel_not_found`, which this
 *   module's caller logs and moves past.
 *
 * The operator's kill switch is the generic one: drop `notifications` from
 * `repoConfig.allowKeys` and step 1 disappears.
 *
 * ## Why provenance, not the value
 *
 * `channel: null` committed by a repo means "send me no digest", and that must
 * beat the operator's `repoChannels` entry. A merged value of `null` cannot say
 * whether the repo asked for that or simply said nothing — so the decision is
 * made on `sources.notifications["slack.channel"] === "repo"`, which is exactly
 * the question being asked.
 */

import type { RunRepoConfig } from "../workflows/simple.js";
import { logger } from "../logging/logger.js";

const log = logger("repo-channel");

/** The Slack routing an operator configured. A subset of `SlackConfig`. */
export interface ChannelRoutingConfig {
  repoChannels: Record<string, string>;
  deliveryChannel?: string;
}

export interface RepoChannelResolution {
  /** The channel to post to, or `undefined` for "this repo gets nothing". */
  channel?: string;
  /** Which of the three answers won — for the log line and the admin view. */
  source: "repo" | "operator-map" | "delivery-channel" | "none";
}

/**
 * @param repo   `owner/repo`.
 * @param routing  The operator's Slack routing (absent when Slack is off).
 * @param repoConfig  The run's resolved repo layer, when one was resolved.
 */
export function resolveRepoChannel(
  repo: string,
  routing: ChannelRoutingConfig | undefined,
  repoConfig?: RunRepoConfig,
): RepoChannelResolution {
  if (!routing) return { source: "none" };

  // 1. The repo's own answer — authoritative when the repo actually gave one,
  //    INCLUDING an explicit null ("send me nothing"), which is why this reads
  //    provenance rather than the merged value.
  if (repoConfig?.sources.notifications?.["slack.channel"] === "repo") {
    const channel = repoConfig.notifications.slack.channel;
    if (channel) return { channel, source: "repo" };
    log.debug("Repo opted out of notifications", { repo });
    return { source: "none" };
  }

  // 2. The operator's per-repo map.
  const mapped = routing.repoChannels[repo];
  if (mapped) return { channel: mapped, source: "operator-map" };

  // 3. The global fallback.
  if (routing.deliveryChannel) return { channel: routing.deliveryChannel, source: "delivery-channel" };

  return { source: "none" };
}
