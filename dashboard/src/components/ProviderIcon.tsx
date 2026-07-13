// Brand marks for the agentic-pi providers we can identify, inlined at build
// time via Vite's `?raw` import. Inlining (rather than an <img>/CSS-mask that
// fetches the asset URL at runtime) keeps them working under the `/admin` base
// with no extra request. Monochrome marks (OpenAI, Copilot) get their hardcoded
// fills stripped and inherit `currentColor` so they read on both the light
// (neaform) and dark (lastlight) themes; colour marks (Claude, Google) keep
// their palette.
import anthropicRaw from "../assets/provider-icons/anthropic.svg?raw";
import openaiRaw from "../assets/provider-icons/openai.svg?raw";
import googleRaw from "../assets/provider-icons/google.svg?raw";
import copilotRaw from "../assets/provider-icons/github-copilot.svg?raw";

type Mark = { raw: string; mono?: boolean };

const MARKS: Record<string, Mark> = {
  anthropic: { raw: anthropicRaw },
  google: { raw: googleRaw },
  openai: { raw: openaiRaw, mono: true },
  "openai-codex": { raw: openaiRaw, mono: true },
  "github-copilot": { raw: copilotRaw, mono: true },
};

/**
 * Provider id is the segment before the first "/" in an agentic-pi model spec
 * ("openai/gpt-5.1" → "openai", "openrouter/x-ai/grok" → "openrouter"), matching
 * agentic-pi's `parseModelSpec`.
 */
export function providerFromModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  const id = slash === -1 ? model : model.slice(0, slash);
  return id.trim().toLowerCase() || null;
}

/** Normalize a raw SVG string to a fixed size, forcing currentColor for mono marks. */
function prepareSvg(raw: string, size: number, mono: boolean): string {
  // Drop any XML prolog / comments so only the <svg> element is inlined.
  let svg = raw.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (mono) {
    // Drop hardcoded colours (but keep `fill="none"`) so paths inherit the
    // svg-level `fill="currentColor"` added below.
    svg = svg.replace(/fill="(?!none)[^"]*"/g, "");
  }
  return svg
    .replace(/\s(?:width|height)="[^"]*"/g, "") // strip only width/height attrs; fill-rule is untouched

    .replace(
      /<svg/,
      `<svg width="${size}" height="${size}"${mono ? ' fill="currentColor"' : ""} style="display:block"`,
    );
}

/**
 * Small brand glyph for the provider behind a model spec, sized to sit inline
 * ahead of the model text. Renders nothing for providers we don't have a mark
 * for (openrouter, mistral, groq, …) so callers can render it unconditionally
 * next to the label.
 */
export function ProviderIcon({
  model,
  size = 14,
  className = "",
}: {
  model: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const provider = providerFromModel(model);
  const mark = provider ? MARKS[provider] : undefined;
  if (!mark) return null;

  return (
    <span
      aria-hidden
      className={className}
      style={{ display: "inline-flex", width: size, height: size, flexShrink: 0, lineHeight: 0 }}
      // Content is a bundled, trusted SVG constant — no user input.
      dangerouslySetInnerHTML={{ __html: prepareSvg(mark.raw, size, !!mark.mono) }}
    />
  );
}
