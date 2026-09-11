import { useState } from "react";
import { Info, Tag } from "lucide-react";
import type { BaseMessage } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";
import { CodeBlock } from "./CodeBlock";

interface Props {
  msg: BaseMessage;
  isNew?: boolean;
}

export function MetaMessage({ msg, isNew }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isSystem = msg.type === "system";
  const label = isSystem ? "system" : "meta";
  const Icon = isSystem ? Info : Tag;
  const text = isSystem
    ? (msg.content as { text?: string })?.text ?? ""
    : JSON.stringify(msg.content, null, 2);

  return (
    <MessageCard
      isNew={isNew}
      timestamp={msg.timestamp}
      dense
      title={
        <>
          <RowIcon Icon={Icon} color="text-muted" bg="bg-base-content/10" />
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted shrink-0">
            {label}
          </span>
          {isSystem && text && (
            <>
              <span className="text-faint shrink-0">-</span>
              <span className="text-2xs text-muted truncate flex-1">
                {text.split("\n")[0]?.slice(0, 140)}
              </span>
            </>
          )}
        </>
      }
      headerRight={
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-2xs text-faint hover:text-base-content font-mono shrink-0"
        >
          {expanded ? "-" : "+"}
        </button>
      }
    >
      {expanded && (
        <CodeBlock code={text} language={isSystem ? "text" : "json"} maxHeight="24rem" />
      )}
    </MessageCard>
  );
}
