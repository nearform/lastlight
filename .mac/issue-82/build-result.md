# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/utils/date.test.ts, src/utils/date.ts

## Code diff
```diff
diff --git a/src/utils/date.test.ts b/src/utils/date.test.ts
new file mode 100644
index 0000000..cc9e333
--- /dev/null
+++ b/src/utils/date.test.ts
@@ -0,0 +1,52 @@
+import { describe, it, expect } from "vitest";
+import { weeksBetween } from "./date.js";
+
+describe("weeksBetween", () => {
+  it("returns 0 for the same date instance", () => {
+    const date = new Date("2024-01-01T00:00:00Z");
+    expect(weeksBetween(date, date)).toBe(0);
+  });
+
+  it("returns 0 for dates less than one week apart", () => {
+    const a = new Date("2024-01-01T00:00:00Z");
+    const b = new Date("2024-01-06T23:59:59Z");
+    expect(weeksBetween(a, b)).toBe(0);
+    expect(weeksBetween(b, a)).toBe(0);
+  });
+
+  it("returns 1 for exactly one week apart, regardless of order", () => {
+    const a = new Date("2024-01-01T00:00:00Z");
+    const b = new Date("2024-01-08T00:00:00Z");
+    expect(weeksBetween(a, b)).toBe(1);
+    expect(weeksBetween(b, a)).toBe(1);
+  });
+
+  it("handles multiple full weeks", () => {
+    const a = new Date("2024-01-01T00:00:00Z");
+    const b = new Date("2024-01-15T00:00:00Z");
+    expect(weeksBetween(a, b)).toBe(2);
+  });
+
+  it("truncates partial weeks", () => {
+    const a = new Date("2024-01-01T00:00:00Z");
+    const b = new Date("2024-01-15T11:59:59Z");
+    // 14 days + 11h59m59s -> still 2 full weeks when truncated
+    expect(weeksBetween(a, b)).toBe(2);
+  });
+
+  it("handles large differences in time", () => {
+    const a = new Date("2000-01-01T00:00:00Z");
+    const b = new Date("2024-01-01T00:00:00Z");
+    const diffMs = Math.abs(b.getTime() - a.getTime());
+    const weeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
+    expect(weeksBetween(a, b)).toBe(weeks);
+  });
+
+  it("is stable across DST transitions using UTC times", () => {
+    // Use a range that crosses a typical DST change (e.g., US 2024-03-10)
+    const beforeDst = new Date("2024-03-01T00:00:00Z");
+    const afterDst = new Date("2024-03-22T00:00:00Z");
+    // 21 days difference -> 3 weeks
+    expect(weeksBetween(beforeDst, afterDst)).toBe(3);
+  });
+});
diff --git a/src/utils/date.ts b/src/utils/date.ts
new file mode 100644
index 0000000..acf77ca
--- /dev/null
+++ b/src/utils/date.ts
@@ -0,0 +1,15 @@
+/**
+ * Returns the number of whole weeks between two dates.
+ *
+ * - Order independent: `weeksBetween(a, b) === weeksBetween(b, a)`.
+ * - Uses UTC epoch millisecond math via `getTime()` to avoid timezone/DST issues.
+ * - Partial weeks are truncated (floored), so the result is always a non-negative integer.
+ */
+export function weeksBetween(a: Date, b: Date): number {
+  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
+
+  const diffMs = Math.abs(a.getTime() - b.getTime());
+  const weeks = Math.floor(diffMs / MS_PER_WEEK);
+
+  return weeks;
+}

```