import { User } from "lucide-react";
import type { BaseMessage } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";
import { Markdown } from "./Markdown";

interface Props {
  msg: BaseMessage;
  isNew?: boolean;
}

export function UserMessage({ msg, isNew }: Props) {
  const c = msg.content as { text?: string } | undefined;
  const text = c?.text ?? "";

  return (
    <MessageCard
      isNew={isNew}
      timestamp={msg.timestamp}
      tint="user"
      title={
        <>
          <RowIcon Icon={User} color="text-warning" bg="bg-warning/15" />
          <span className="text-2xs font-semibold uppercase tracking-wider text-warning shrink-0">
            user
          </span>
        </>
      }
    >
      {text ? (
        <Markdown source={text} />
      ) : (
        <span className="text-2xs text-faint italic">(empty)</span>
      )}
    </MessageCard>
  );
}
