/**
 * RFC-1123 label: lowercase `[a-z0-9]` + `-`, at most 63 chars. Kubernetes
 * object names (and this label form of them) share this shape. Centralises
 * the slug transform duplicated across `naming.ts` (`podNameFor`) and
 * `pvc.ts` (`pvcNameFor`), and gives the "derived name stays within 63
 * chars" contract a real runtime guard (F6) instead of the comment-only
 * `SECRET_SUFFIX_BUDGET` reservation it replaces at the point of use
 * (`secret.ts`'s `secretNameFor`).
 */
export class Rfc1123Label {
  /** RFC-1123 label length cap shared by every k8s object name. */
  static readonly MAX_LENGTH = 63;

  private constructor(readonly value: string) {}

  /**
   * Lowercases `raw`, collapses every run of characters outside `[a-z0-9]`
   * into a single `-`, and strips any leading/trailing `-` left behind.
   * `opts.prefix` (e.g. `"ll-"`, `"ws-"`) is prepended before truncating to
   * `opts.maxLength` (default {@link Rfc1123Label.MAX_LENGTH}); truncation
   * can itself leave a dangling `-`, so it is stripped again after slicing.
   */
  static slug(raw: string, opts?: { prefix?: string; maxLength?: number }): Rfc1123Label {
    const prefix = opts?.prefix ?? "";
    const maxLength = opts?.maxLength ?? Rfc1123Label.MAX_LENGTH;
    const cleaned = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const value = `${prefix}${cleaned}`.slice(0, maxLength).replace(/-+$/g, "");
    return new Rfc1123Label(value);
  }

  /**
   * Appends `-<suffix>`, throwing if the result would exceed
   * {@link Rfc1123Label.MAX_LENGTH} — the enforced form of the "derived name
   * stays within budget" invariant that used to live only as a comment next
   * to a hand-tuned reservation constant (F6).
   */
  withSuffix(suffix: string): Rfc1123Label {
    const value = `${this.value}-${suffix}`;
    if (value.length > Rfc1123Label.MAX_LENGTH) {
      throw new Error(
        `Rfc1123Label.withSuffix: "${this.value}" + "-${suffix}" is ${value.length} chars, ` +
          `over the ${Rfc1123Label.MAX_LENGTH}-char RFC-1123 label cap`,
      );
    }
    return new Rfc1123Label(value);
  }
}
