import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  resolveTarget,
  saveServerHome,
  resolveServerHome,
  defaultServerHome,
  configPath,
  DEFAULT_URL,
} from "./cli-config.js";

let tmpHome: string;
let origHome: string | undefined;
let origUrl: string | undefined;
let origToken: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ll-cli-"));
  origHome = process.env.HOME;
  origUrl = process.env.LASTLIGHT_URL;
  origToken = process.env.LASTLIGHT_TOKEN;
  process.env.HOME = tmpHome;
  delete process.env.LASTLIGHT_URL;
  delete process.env.LASTLIGHT_TOKEN;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origUrl === undefined) delete process.env.LASTLIGHT_URL; else process.env.LASTLIGHT_URL = origUrl;
  if (origToken === undefined) delete process.env.LASTLIGHT_TOKEN; else process.env.LASTLIGHT_TOKEN = origToken;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("cli-config", () => {
  it("round-trips save → load", () => {
    expect(loadConfig()).toBeNull();
    saveConfig({ url: "https://ll.example.com", token: "tok-123" });
    const cfg = loadConfig();
    expect(cfg?.url).toBe("https://ll.example.com");
    expect(cfg?.token).toBe("tok-123");
    expect(cfg?.savedAt).toBeTruthy();
  });

  it("writes the config file mode 0600", () => {
    saveConfig({ url: "https://x", token: "t" });
    const mode = fs.statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("clearConfig removes the file", () => {
    saveConfig({ url: "https://x", token: "t" });
    clearConfig();
    expect(loadConfig()).toBeNull();
    expect(() => clearConfig()).not.toThrow(); // idempotent
  });

  it("env vars override the saved file", () => {
    saveConfig({ url: "https://saved", token: "saved-tok" });
    process.env.LASTLIGHT_URL = "https://env";
    process.env.LASTLIGHT_TOKEN = "env-tok";
    const t = resolveTarget();
    expect(t.url).toBe("https://env");
    expect(t.token).toBe("env-tok");
  });

  it("explicit override beats env and file", () => {
    process.env.LASTLIGHT_URL = "https://env";
    const t = resolveTarget({ url: "https://flag", token: "flag-tok" });
    expect(t.url).toBe("https://flag");
    expect(t.token).toBe("flag-tok");
  });

  it("saveServerHome persists without clobbering credentials", () => {
    saveConfig({ url: "https://ll.example.com", token: "tok-123" });
    saveServerHome("/home/lastlight/lastlight");
    const cfg = loadConfig();
    expect(cfg?.token).toBe("tok-123"); // creds preserved
    expect(cfg?.serverHome).toBe("/home/lastlight/lastlight");
  });

  it("resolveServerHome: --home > LASTLIGHT_HOME > saved > default", () => {
    expect(resolveServerHome()).toBe(defaultServerHome());
    saveServerHome("/saved/home");
    expect(resolveServerHome()).toBe("/saved/home");
    process.env.LASTLIGHT_HOME = "/env/home";
    expect(resolveServerHome()).toBe("/env/home");
    expect(resolveServerHome("/flag/home")).toBe("/flag/home");
    delete process.env.LASTLIGHT_HOME;
  });

  it("falls back to the default URL and trims trailing slashes", () => {
    const t = resolveTarget();
    expect(t.url).toBe(DEFAULT_URL);
    expect(t.token).toBe("");
    saveConfig({ url: "https://ll.example.com/", token: "t" });
    expect(resolveTarget().url).toBe("https://ll.example.com");
  });
});
