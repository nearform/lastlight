# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: src/index.ts, src/utils/hello.ts, tests/hello.test.ts

## Code diff
```diff
diff --git a/src/index.ts b/src/index.ts
index 27ab30a..d41ce42 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -23,6 +23,7 @@ import { runSimpleWorkflow, type SimpleWorkflowRequest } from "./workflows/simpl
 import type { RunnerCallbacks } from "./workflows/runner.js";
 import { resumeOrphanedWorkflows } from "./workflows/resume.js";
 import type { EventEnvelope } from "./connectors/types.js";
+export { printHello } from "./utils/hello.js";
 
 /**
  * Pre-flight validation — checks that config is sane before starting any
diff --git a/src/utils/hello.ts b/src/utils/hello.ts
new file mode 100644
index 0000000..f02bc92
--- /dev/null
+++ b/src/utils/hello.ts
@@ -0,0 +1,8 @@
+/**
+ * Print a friendly greeting to stdout.
+ *
+ * @param name - The name to include in the greeting.
+ */
+export function printHello(name: string): void {
+  console.log(`Hello ${name}!`);
+}
diff --git a/tests/hello.test.ts b/tests/hello.test.ts
new file mode 100644
index 0000000..d5061ac
--- /dev/null
+++ b/tests/hello.test.ts
@@ -0,0 +1,28 @@
+import { describe, expect, it, vi, afterEach } from "vitest";
+import { printHello } from "../src/utils/hello.js";
+
+const originalLog = console.log;
+
+afterEach(() => {
+  console.log = originalLog;
+});
+
+describe("printHello", () => {
+  it("prints a greeting for the provided name", () => {
+    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
+
+    printHello("World");
+
+    expect(spy).toHaveBeenCalledTimes(1);
+    expect(spy).toHaveBeenCalledWith("Hello World!");
+  });
+
+  it("prints the correct greeting for another name", () => {
+    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
+
+    printHello("Alice");
+
+    expect(spy).toHaveBeenCalledTimes(1);
+    expect(spy).toHaveBeenCalledWith("Hello Alice!");
+  });
+});

```