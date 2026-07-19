import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * An anchor to github.com that opens in a new tab. Used for the repo names and
 * issue/PR numbers scattered across the workflow / repo lists so a user can
 * jump straight to the related item on GitHub.
 *
 * Calls `stopPropagation` on click so it can live inside a clickable row
 * (`role="button"`) without also triggering the row's selection handler.
 */
export function GhLink({
  href,
  children,
  className,
  title = "Open on GitHub",
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={clsx("hover:text-primary hover:underline transition-colors", className)}
    >
      {children}
    </a>
  );
}
