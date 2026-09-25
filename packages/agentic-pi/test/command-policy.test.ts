import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyCommand,
  decideCommand,
  modeFor,
  parseCommandPolicy,
  splitSegments,
  stripPrefixes,
} from "../src/command-policy.js";
import { type CommandPolicyEvent, commandPolicyGate } from "../src/command-policy-gate.js";

const CWD = "/work/repo";
const classes = (cmd: string, cwd = CWD) => [...new Set(classifyCommand(cmd, cwd).map((m) => m.cls))].sort();

describe("classifyCommand — install, per language", () => {
  const installs = [
    "npm install", "npm i lodash", "npm ci", "npm --prefix . ci", "pnpm install --frozen-lockfile",
    "pnpm add -D vitest", "yarn", "yarn --frozen-lockfile", "yarn add left-pad", "bun install", "bun add zod",
    "pnpm dlx create-foo", "bunx cowsay", "npx -y prettier .", "npx --package typescript tsc", "npx eslint@8.57.0 .",
    "pip install -r requirements.txt", "pip3 install requests", "python -m pip install .", "python3.12 -m pip install x",
    "uv pip install x", "uv sync", "uv add httpx", "poetry install", "poetry add x", "pipenv install", "conda install numpy",
    "bundle install", "gem install rails",
    "cargo install ripgrep", "cargo fetch", "cargo add serde",
    "go get example.com/x", "go mod download", "go install ./cmd/...",
    "composer install", "composer require vendor/pkg",
    "dotnet restore", "dotnet add package Newtonsoft.Json", "nuget install Foo",
    "mvn -q install", "mvn dependency:resolve", "./gradlew build --refresh-dependencies",
    "apt-get install -y jq", "brew install jq",
  ];
  for (const cmd of installs) {
    test(cmd, () => assert.ok(classes(cmd).includes("install"), `${cmd} → ${classes(cmd)}`));
  }
});

describe("classifyCommand — test, per language", () => {
  const tests = [
    "npm test", "npm t", "npm run test", "npm run test:unit", "npm run lint:check", "npm run typecheck",
    "pnpm test", "pnpm --filter core test", "pnpm lint", "pnpm -r run test", "yarn test", "yarn lint", "bun test",
    "bun run test", "npx vitest run", "pnpm exec jest", "vitest", "jest --ci", "mocha", "npx ava",
    "node_modules/.bin/vitest run", "./node_modules/.bin/jest", "npx playwright test", "node --test", "tsx --test test/x.test.ts",
    "npx turbo run test", "turbo lint",
    "pytest", "pytest -x tests/", "python -m pytest", "python3 -m unittest discover", "uv run pytest", "poetry run pytest", "tox", "nox",
    "go test ./...", "cargo test", "cargo nextest run",
    "mvn test", "mvn -B verify", "./gradlew test", "gradle check",
    "rspec", "bundle exec rspec", "rake test", "rails test",
    "vendor/bin/phpunit", "phpunit", "pest", "composer test",
    "dotnet test", "make test", "make check",
  ];
  for (const cmd of tests) {
    test(cmd, () => assert.ok(classes(cmd).includes("test"), `${cmd} → ${classes(cmd)}`));
  }
});

describe("classifyCommand — not a match", () => {
  const benign = [
    "ls -la", "cat package.json", "git diff HEAD~1", "grep -rn pytest .", 'echo "run npm test later"',
    "rg 'npm install' docs/", "node -e 'console.log(1)'", "npx tsc --noEmit", "npx eslint src/a.ts", "tsc -p .",
    "npm view fastify version", "npm ls", "npm init -y", "yarn --version", "pnpm why x", "go vet ./...",
    "cargo build", "make", "python script.py", "sed -n 1,20p src/x.ts", "lastlight-facts probes --dir .lastlight",
    "node --test-reporter=spec x.js",
  ];
  for (const cmd of benign) {
    test(cmd, () => assert.deepEqual(classes(cmd), [], `${cmd} → ${classes(cmd)}`));
  }
});

describe("normalisation", () => {
  test("cd x && npm ci", () => assert.deepEqual(classes("cd x && npm ci"), ["install"]));
  test("FOO=1 pytest", () => assert.deepEqual(classes("FOO=1 pytest"), ["test"]));
  test("timeout 60 go test ./...", () => assert.deepEqual(classes("timeout 60 go test ./..."), ["test"]));
  test("timeout -s KILL 5m npm test", () => assert.deepEqual(classes("timeout -s KILL 5m npm test"), ["test"]));
  test("env CI=1 NODE_ENV=test npm test", () => assert.deepEqual(classes("env CI=1 NODE_ENV=test npm test"), ["test"]));
  test("sudo -u agent npm ci / nice -n 5 pytest / time cargo test", () => {
    assert.deepEqual(classes("sudo -u agent npm ci"), ["install"]);
    assert.deepEqual(classes("nice -n 5 pytest"), ["test"]);
    assert.deepEqual(classes("time cargo test"), ["test"]);
  });
  test("the measured gate re-creation: both classes", () => {
    assert.deepEqual(classes("npm ci > /tmp/gate.log 2>&1; echo EXIT=$?"), ["install"]);
    assert.deepEqual(classes("npm run lint:check && npm test"), ["test"]);
    assert.deepEqual(classes("npm ci && npm test 2>&1 | tail -50"), ["install", "test"]);
  });
  test("subshells, pipes, || and newlines", () => {
    assert.deepEqual(classes("(cd pkg && pnpm test)"), ["test"]);
    assert.deepEqual(classes("ls\nnpm test"), ["test"]);
    assert.deepEqual(classes("npm test || true"), ["test"]);
    assert.deepEqual(classes("npm test &> /tmp/log"), ["test"]);
    assert.deepEqual(classes("npm test \\\n  --silent"), ["test"]);
  });
  test("separators inside quotes do not split", () => {
    assert.deepEqual(splitSegments(`echo "a && npm test" ; ls`), [`echo "a && npm test"`, "ls"]);
    assert.deepEqual(classes(`bash -c "echo; ls"`), []);
  });
  test("stripPrefixes leaves the real command", () => {
    assert.deepEqual(stripPrefixes(["FOO=1", "timeout", "60", "go", "test"]), ["go", "test"]);
    assert.deepEqual(stripPrefixes(["(cd", "x"]), ["cd", "x"]);
  });
});

describe("install-scratch — installs outside the checkout", () => {
  test("cd into a scratch dir first", () => {
    assert.deepEqual(classes("mkdir -p /tmp/probe && cd /tmp/probe && npm install fastify@5"), ["install-scratch"]);
    assert.deepEqual(classes("cd /tmp/e8 && npm i eslint@8.57.0"), ["install-scratch"]);
  });
  test("a dir flag that points outside", () => {
    assert.deepEqual(classes("npm install --prefix /tmp/probe @slack/web-api@^7.15.0"), ["install-scratch"]);
    assert.deepEqual(classes("pip install --target=/tmp/py requests"), ["install-scratch"]);
    assert.deepEqual(classes("pnpm -C /tmp/x add zod"), ["install-scratch"]);
  });
  test("global and user installs", () => {
    assert.deepEqual(classes("npm install -g typescript"), ["install-scratch"]);
    assert.deepEqual(classes("pip install --user x"), ["install-scratch"]);
  });
  test("home dir is outside; relative cds inside the repo are not", () => {
    assert.deepEqual(classes("cd && npm i x"), ["install-scratch"]);
    assert.deepEqual(classes("cd ~/scratch && npm i x"), ["install-scratch"]);
    assert.deepEqual(classes("cd packages/core && npm ci"), ["install"]);
    assert.deepEqual(classes("cd /work/repo/sub && npm ci"), ["install"]);
    assert.deepEqual(classes("cd .. && npm ci"), ["install-scratch"]);
  });
  test("an unknowable cd errs toward the repo", () => {
    assert.deepEqual(classes('cd "$TMP" && npm ci'), ["install"]);
  });
  test("npx with a version fetches wherever it runs", () => {
    assert.deepEqual(classes("npx eslint@8.57.0 --version"), ["install"]);
  });
});

describe("parseCommandPolicy", () => {
  test("accepts the canonical map and a reason", () => {
    assert.deepEqual(parseCommandPolicy('{"install":"block","test":"log","reason":"no"}', "x"), {
      install: "block",
      test: "log",
      reason: "no",
    });
  });
  test("refuses unknown classes, unknown modes, non-objects and bad JSON", () => {
    assert.throws(() => parseCommandPolicy('{"network":"block"}', "--command-policy"), /unknown command class 'network'/);
    assert.throws(() => parseCommandPolicy('{"test":"deny"}', "--command-policy"), /test must be one of allow\|log\|block/);
    assert.throws(() => parseCommandPolicy("[]", "--command-policy"), /must be an object/);
    assert.throws(() => parseCommandPolicy("{", "--command-policy"), /must be JSON/);
    assert.throws(() => parseCommandPolicy('{"reason":""}', "--command-policy"), /reason must be a non-empty string/);
  });
  test("install-scratch falls back to install; everything else to allow", () => {
    assert.equal(modeFor({ install: "block" }, "install-scratch"), "block");
    assert.equal(modeFor({ install: "block", "install-scratch": "log" }, "install-scratch"), "log");
    assert.equal(modeFor({}, "test"), "allow");
  });
});

describe("decideCommand", () => {
  test("block wins over log, and names the blocking classes", () => {
    const d = decideCommand({ install: "block", test: "log" }, "npm ci && npm test", CWD);
    assert.equal(d.action, "block");
    assert.equal(d.matches.length, 2);
    assert.match(d.reason!, /^Blocked by this phase's command policy \(install\)\. This run does not install dependencies/);
  });
  test("log runs, allow says nothing", () => {
    assert.equal(decideCommand({ test: "log" }, "npm test", CWD).action, "log");
    assert.deepEqual(decideCommand({ test: "allow", install: "log" }, "npm test", CWD), { action: "allow", matches: [] });
  });
  test("a configured reason replaces the default text", () => {
    const d = decideCommand({ test: "block", reason: "Run one file only." }, "npm test", CWD);
    assert.equal(d.reason, "Blocked by this phase's command policy (test). Run one file only.");
  });
  test("scratch installs can be allowed while repo installs stay blocked", () => {
    const p = { install: "block", "install-scratch": "allow" } as const;
    assert.equal(decideCommand(p, "cd /tmp/p && npm i fastify@5", CWD).action, "allow");
    assert.equal(decideCommand(p, "npm ci", CWD).action, "block");
  });
});

describe("commandPolicyGate", () => {
  function register(factory: NonNullable<ReturnType<typeof commandPolicyGate>>) {
    const handlers = new Map<string, (event: unknown) => unknown>();
    factory({ on: (name: string, h: (e: unknown) => unknown) => handlers.set(name, h) } as unknown as ExtensionAPI);
    return handlers.get("tool_call")!;
  }

  test("no policy, or an all-allow one, registers nothing", () => {
    assert.equal(commandPolicyGate(undefined, CWD, () => {}), undefined);
    assert.equal(commandPolicyGate({ test: "allow", reason: "x" }, CWD, () => {}), undefined);
  });

  test("blocks a bash call, returns the reason, and emits one event per match", async () => {
    const events: CommandPolicyEvent[] = [];
    const handler = register(commandPolicyGate({ install: "block", test: "block" }, CWD, (e) => events.push(e))!);
    const result = await handler({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "npm ci && npm test" } });
    assert.equal((result as { block: boolean }).block, true);
    assert.match((result as { reason: string }).reason, /command policy \(install, test\)/);
    assert.deepEqual(
      events.map((e) => [e.type, e.action, e.class, e.pattern]),
      [
        ["command_policy", "block", "install", "js-install"],
        ["command_policy", "block", "test", "js-test"],
      ],
    );
  });

  test("log lets the call through and still emits", async () => {
    const events: CommandPolicyEvent[] = [];
    const handler = register(commandPolicyGate({ test: "log" }, CWD, (e) => events.push(e))!);
    const result = await handler({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "pytest -x" } });
    assert.equal(result, undefined);
    assert.deepEqual(events.map((e) => [e.action, e.class, e.command]), [["log", "test", "pytest -x"]]);
  });

  test("ignores other tools and allowed commands", async () => {
    const events: CommandPolicyEvent[] = [];
    const handler = register(commandPolicyGate({ test: "block" }, CWD, (e) => events.push(e))!);
    assert.equal(await handler({ type: "tool_call", toolName: "read", toolCallId: "1", input: { path: "npm test" } }), undefined);
    assert.equal(await handler({ type: "tool_call", toolName: "bash", toolCallId: "2", input: { command: "ls" } }), undefined);
    assert.equal(events.length, 0);
  });
});
