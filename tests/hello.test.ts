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
