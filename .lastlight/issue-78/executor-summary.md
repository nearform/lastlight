# Executor summary

Changes implemented:

1. New utility function
   - Added `src/utils/hello.ts`:
     ```ts
     /**
      * Print a friendly greeting to stdout.
      *
      * @param name - The name to include in the greeting.
      */
     export function printHello(name: string): void {
       console.log(`Hello ${name}!`);
     }
     ```

2. Public export
   - Updated `src/index.ts` to re-export the helper:
     ```ts
     import { resumeOrphanedWorkflows } from "./workflows/resume.js";
     import type { EventEnvelope } from "./connectors/types.js";
     export { printHello } from "./utils/hello.js";
     ```
     (Inserted directly after the existing `EventEnvelope` import.)

3. Tests
   - Added `tests/hello.test.ts`:
     ```ts
     import { describe, expect, it, vi, afterEach } from "vitest";
     import { printHello } from "../src/utils/hello.js";

     const originalLog = console.log;

     afterEach(() => {
       console.log = originalLog;
     });

     describe("printHello", () => {
       it("prints a greeting for the provided name", () => {
         const spy = vi.spyOn(console, "log").mockImplementation(() => {});

         printHello("World");

         expect(spy).toHaveBeenCalledTimes(1);
         expect(spy).toHaveBeenCalledWith("Hello World!");
       });

       it("prints the correct greeting for another name", () => {
         const spy = vi.spyOn(console, "log").mockImplementation(() => {});

         printHello("Alice");

         expect(spy).toHaveBeenCalledTimes(1);
         expect(spy).toHaveBeenCalledWith("Hello Alice!");
       });
     });
     ```

Verification:

- Tests:
  - `npm test`
    - All existing tests plus the new `tests/hello.test.ts` passed.
    - Summary: `Test Files  27 passed (27); Tests  467 passed | 1 todo (468)`.

- Build / typecheck:
  - `npm run build`
    - Completed successfully (`tsc` exited cleanly, no type errors).
