import type { Connector, EventEnvelope } from "./types.js";
import { logger } from "../logging/logger.js";

const log = logger("connectors");

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

/**
 * ConnectorRegistry manages all event source connectors.
 * Register connectors, attach a unified event handler, start/stop all.
 */
export class ConnectorRegistry {
  private connectors: Map<string, Connector> = new Map();
  private handler: EventHandler | null = null;

  register(connector: Connector) {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector "${connector.name}" already registered`);
    }
    this.connectors.set(connector.name, connector);

    // Wire up event handler
    connector.on("event", (envelope: EventEnvelope) => {
      if (this.handler) {
        this.handler(envelope).catch((err) => {
          log.error("Event handler error", { connector: connector.name, err });
        });
      }
    });
  }

  onEvent(handler: EventHandler) {
    this.handler = handler;
  }

  async startAll(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      log.info("Starting connector", { connector: name });
      await connector.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, connector] of this.connectors) {
      log.info("Stopping connector", { connector: name });
      await connector.stop();
    }
  }
}

export { type Connector, type EventEnvelope, type EventType } from "./types.js";
export { GitHubWebhookConnector, type GitHubWebhookConfig } from "./github-webhook.js";
export {
  MessagingConnector,
  SessionManager,
  MessageDeliveryService,
  withThreadTranscript,
  recordThreadMessage,
  recordThreadMessageForThread,
} from "./messaging/index.js";
export { SlackConnector, type SlackConnectorConfig } from "./slack/index.js";
