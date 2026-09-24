import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { BaseMessage } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";
import { Markdown } from "./Markdown";

interface Props {
  msg: BaseMessage;
  isNew?: boolean;
}

/** pi's stop reasons for a turn that ended the ordinary way. */
const ROUTINE_STOPS = new Set(["stop", "toolUse"]);

/**
 * Chips for the two things worth noticing on a turn: it ended abnormally
 * (length cap, refusal, content filter — the provider's own word when it gave
 * one), or a gateway served a different model than the one requested.
 */
export function assistantChips(meta: BaseMessage["metadata"]): string[] {
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const chips: string[] = [];
  const finish = s(meta?.finishReason);
  const raw = s(meta?.rawStopReason);
  if (finish && !ROUTINE_STOPS.has(finish)) {
    chips.push(raw && raw !== finish ? `stopped: ${finish} (${raw})` : `stopped: ${finish}`);
  }
  const model = s(meta?.model);
  const served = s(meta?.responseModel);
  if (served && !(model && (model === served || model.endsWith(`/${served}`)))) {
    chips.push(`served by ${served}`);
  }
  return chips;
}

export function AssistantMessage({ msg, isNew }: Props) {
  const c = msg.content as { text?: string; reasoning?: string } | undefined;
  const text = c?.text ?? "";
  const reasoning = c?.reasoning ?? "";
  const [showReasoning, setShowReasoning] = useState(false);
  const chips = assistantChips(msg.metadata);

  return (
    <MessageCard
      isNew={isNew}
      timestamp={msg.timestamp}
      title={
        <>
          <RowIcon Icon={Sparkles} color="text-primary" bg="bg-primary/15" />
          <span className="text-2xs font-semibold uppercase tracking-wider text-primary shrink-0">
            assistant
          </span>
          {chips.map((chip) => (
            <span key={chip} className="text-2xs font-mono text-warning truncate">
              {chip}
            </span>
          ))}
        </>
      }
      headerRight={
        reasoning ? (
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="text-2xs text-accent hover:text-accent/80 font-mono"
          >
            {showReasoning ? "hide" : "show"} reasoning
          </button>
        ) : null
      }
    >
      {showReasoning && reasoning && (
        <div className="mb-2 p-2 border-l-2 border-accent/40 bg-base-300/40 rounded text-xs text-strong italic">
          <Markdown source={reasoning} />
        </div>
      )}
      {text ? (
        <Markdown source={text} />
      ) : (
        <span className="text-2xs text-faint italic">(empty)</span>
      )}
    </MessageCard>
  );
}
