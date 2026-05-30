# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/utils/string.test.ts, src/utils/string.ts

## Code diff
```diff
diff --git a/src/utils/string.test.ts b/src/utils/string.test.ts
new file mode 100644
index 0000000..6ca3e79
--- /dev/null
+++ b/src/utils/string.test.ts
@@ -0,0 +1,35 @@
+import { describe, expect, it } from "vitest";
+import { truncateMiddle } from "./string";
+
+describe("truncateMiddle", () => {
+  it("returns short strings unchanged when length is less than max", () => {
+    const text = "short";
+    const result = truncateMiddle(text, 10);
+    expect(result).toBe(text);
+  });
+
+  it("returns exact-length strings unchanged when length equals max", () => {
+    const text = "exact";
+    const result = truncateMiddle(text, text.length);
+    expect(result).toBe(text);
+  });
+
+  it("truncates long strings in the middle with an ellipsis and respects max length", () => {
+    const text = "abcdefghijklmnopqrstuvwxyz";
+    const max = 10;
+    const result = truncateMiddle(text, max);
+
+    expect(result.length).toBeLessThanOrEqual(max);
+    expect(result).toContain("…");
+  });
+
+  it("returns empty string when max is less than or equal to zero", () => {
+    expect(truncateMiddle("abc", 0)).toBe("");
+    expect(truncateMiddle("abc", -5)).toBe("");
+  });
+
+  it("returns a single ellipsis when max is 1 or 2", () => {
+    expect(truncateMiddle("abcdef", 1)).toBe("…");
+    expect(truncateMiddle("abcdef", 2)).toBe("…");
+  });
+});
diff --git a/src/utils/string.ts b/src/utils/string.ts
new file mode 100644
index 0000000..cefec68
--- /dev/null
+++ b/src/utils/string.ts
@@ -0,0 +1,33 @@
+/**
+ * Truncate a string in the middle, inserting a single ellipsis character (…)
+ * so that the resulting string length is at most `max`.
+ *
+ * Behaviour:
+ * - If `text.length <= max`, the original `text` is returned unchanged.
+ * - If `max <= 0`, an empty string is returned.
+ * - If `max` is 1 or 2, a single ellipsis character is returned.
+ * - Otherwise, the string is truncated keeping characters from the start and end
+ *   with a single ellipsis between them.
+ */
+export function truncateMiddle(text: string, max: number): string {
+  if (max <= 0) {
+    return "";
+  }
+
+  if (text.length <= max) {
+    return text;
+  }
+
+  if (max <= 2) {
+    return "…";
+  }
+
+  const remaining = max - 1; // reserve 1 char for ellipsis
+  const frontLen = Math.ceil(remaining / 2);
+  const backLen = Math.floor(remaining / 2);
+
+  const start = text.slice(0, frontLen);
+  const end = text.slice(text.length - backLen);
+
+  return `${start}…${end}`;
+}

```