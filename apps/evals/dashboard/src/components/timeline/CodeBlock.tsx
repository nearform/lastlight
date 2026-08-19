import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import DOMPurify from "dompurify";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "../../prism-theme.css";
import AnsiToHtml from "ansi-to-html";
import { useTheme } from "../../hooks/useTheme";

// Register a `template-block` token on markdown + yaml so the mustache-style
// `{{ ... }}` placeholders our prompt templates and workflow definitions use
// (e.g. `{{branch}}`, `{{models.architect}}`, `{{phaseOutputs.x.output}}`)
// pop visually instead of blending in with surrounding prose. Inserting at
// the front of the language object means Prism tries this token first, so
// `{{branch}}` inside **bold** still gets highlighted.
const TEMPLATE_BLOCK = /\{\{[^{}\n]+\}\}/;
for (const lang of ["markdown", "yaml"] as const) {
  const grammar = Prism.languages[lang];
  if (grammar && !(grammar as Record<string, unknown>)["template-block"]) {
    Prism.languages[lang] = {
      "template-block": TEMPLATE_BLOCK,
      ...grammar,
    };
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[\d;]*m/;

interface Props {
  code: string;
  language?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, language = "text", maxHeight }: Props) {
  const ref = useRef<HTMLElement>(null);
  const lang = Prism.languages[language] ? language : "text";
  const hasAnsi = useMemo(() => ANSI_RE.test(code), [code]);
  const { isDark } = useTheme();

  useEffect(() => {
    if (ref.current && !hasAnsi) Prism.highlightElement(ref.current);
  }, [code, lang, hasAnsi]);

  // The code-block background is `base-300`, which is light in the neaform
  // theme — so the default light-gray fg needs to darken there to stay legible.
  const ansiConverter = useMemo(
    () =>
      new AnsiToHtml({
        fg: isDark ? "#c9d1d9" : "#1b2330",
        bg: "transparent",
        newline: true,
        escapeXML: true,
      }),
    [isDark],
  );

  const ansiHtml = useMemo(
    () => (hasAnsi ? DOMPurify.sanitize(ansiConverter.toHtml(code), { ADD_ATTR: ["style"] }) : ""),
    [code, hasAnsi, ansiConverter],
  );

  return (
    <pre
      className={clsx(
        "m-0 font-mono text-xs rounded overflow-auto",
        // base-300 chip reads as a subtle surface on the dark page; on the light
        // page it's a heavy grey block, so use a much lighter tint there.
        isDark ? "bg-base-300/60" : "bg-base-200/50",
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {hasAnsi ? (
        <code
          className="bg-transparent! text-inherit! p-3! block whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: ansiHtml }}
        />
      ) : (
        <code ref={ref} className={`language-${lang} bg-transparent! text-inherit! p-3! block`}>
          {code}
        </code>
      )}
    </pre>
  );
}
