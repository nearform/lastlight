/**
 * `rules/review.yaml` — the ruleset itself, against the real binary.
 *
 * The failure mode here is the one this whole package is engineered against,
 * with a YAML file in the crashing seat: **a rule that never fires reads
 * exactly like a clean scan.** `patterns` is honest about it — a config error
 * lands in opengrep's `errors[]` and becomes a `degraded[]` entry — but the
 * finding list is empty either way, and an empty finding list is what a reader
 * skims past.
 *
 * That is not hypothetical. The seven-rule TypeScript ruleset that shipped with
 * WP1 was **never valid YAML**: `- pattern: $JWT.verify(…, {..., algorithms:
 * ["none"], ...})` is a plain scalar containing `: `, which YAML rejects, so
 * opengrep refused the whole config on every run. Nobody saw it because no
 * machine that ran the suite had the binary installed.
 *
 * So there are two guards, and they are deliberately not the same guard:
 *
 *  1. **`describes the file with no binary at all`** — a dependency-free lint
 *     for the exact shape that broke it. This one runs everywhere, including
 *     the CI runner and the developer Mac with no opengrep.
 *  2. **`fires on real code`** — the real 1.27.1 binary over a fixture holding
 *     a true positive AND a near-miss true negative for every rule. It is
 *     skipped when the binary is absent, because the alternative is a suite
 *     that cannot run at all off the sandbox image.
 *
 * Fixtures are real files with real syntax, like everywhere else here: the
 * claim is "opengrep's Java front-end matches this pattern against this code",
 * and there is no way to mock that without mocking the claim.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { defaultRulesPath, opengrepArgs } from "../src/patterns.js";
import { resolveToolBin } from "../src/toolchain.js";
import { runExtractor } from "../src/run.js";
import { makeFixture } from "./helpers.js";
import type { PatternsDocument } from "../src/schema.js";

const RULES = defaultRulesPath();
const OPENGREP = resolveToolBin("opengrep", process.env);

/** Every `- id:` in the file, in order. */
function ruleIds(): string[] {
  return readFileSync(RULES, "utf8")
    .split("\n")
    .map((line) => /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)?.[1])
    .filter((id): id is string => Boolean(id));
}

describe("rules/review.yaml — loadable without any binary present", () => {
  /**
   * YAML's plain (unquoted) scalar may not contain `: `. Semgrep patterns are
   * full of it — every object-literal pattern has one — so this is not an
   * exotic mistake, it is the default one, and it costs the entire ruleset
   * rather than the single rule that carries it.
   */
  it("never spells a pattern as an unquoted scalar containing `: `", () => {
    const offenders = readFileSync(RULES, "utf8")
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => {
        const value = /^\s*-?\s*pattern(?:-not|-inside|-not-inside)?:\s*(.*)$/.exec(line)?.[1];
        if (!value || value === "" || value === "|" || value === ">-") return false;
        const quoted = /^(["']).*\1$/.test(value.trim());
        return !quoted && /:\s/.test(value);
      });
    expect(
      offenders.map((o) => `${o.number}: ${o.line.trim()}`),
      "an unquoted `: ` makes opengrep refuse the WHOLE config, and the run stays green with findings: []",
    ).toEqual([]);
  });

  it("gives every rule a unique id", () => {
    const ids = ruleIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, "opengrep keys findings by id; a duplicate silently wins").toBe(
      ids.length,
    );
  });

  /**
   * 40 of 50 PRs in the pr-review corpus are not TypeScript. A ruleset that
   * regressed to TS-only would produce an empty envelope on four fifths of the
   * measurement set, which is the shape §D2 needs to be able to distinguish
   * from "clean".
   */
  it("covers every language the corpus is actually made of", () => {
    const declared = new Set(
      [...readFileSync(RULES, "utf8").matchAll(/^\s*languages:\s*\[([^\]]+)\]/gm)].flatMap((m) =>
        m[1].split(",").map((l) => l.trim()),
      ),
    );
    for (const language of ["typescript", "javascript", "java", "go", "python", "ruby"]) {
      expect(declared.has(language), `no rule targets ${language}`).toBe(true);
    }
  });
});

// ── the real-binary half ─────────────────────────────────────────────────────
//
// One file per language per side. The `tp/` tree is what every rule must fire
// on; the `tn/` tree is the near miss — the parameterised query, the literal
// command, the `retryDelay` that is also `Math.random()`. A rule that fires on
// `tn/` has stopped discriminating; a rule that fires on neither is dead
// weight that reads as coverage.

const TRUE_POSITIVES: Record<string, string> = {
  "Fixture.java": `import java.sql.*;
import java.security.cert.X509Certificate;
import javax.net.ssl.*;
import javax.servlet.http.Cookie;
import javax.script.ScriptEngine;

public class Fixture {
  void sql(Statement st, Connection c, String name) throws Exception {
    st.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
    st.executeUpdate(String.format("DELETE FROM users WHERE name = '%s'", name));
  }
  void shell(String name) throws Exception {
    Runtime.getRuntime().exec("git log " + name);
    new ProcessBuilder("sh", "-c", "git log " + name).start();
  }
  void dynamic(ScriptEngine e, String src) throws Exception { e.eval(src); }
  void random() {
    String sessionToken = String.valueOf(Math.random());
    java.util.Random r = new java.util.Random();
    long apiKey = r.nextLong();
  }
  void tls(HttpsURLConnection conn) {
    conn.setHostnameVerifier(new HostnameVerifier() {
      public boolean verify(String hostname, SSLSession session) { return true; }
    });
  }
  TrustManager trust() {
    return new X509TrustManager() {
      public void checkServerTrusted(X509Certificate[] chain, String authType) { }
      public void checkClientTrusted(X509Certificate[] chain, String authType) { }
      public X509Certificate[] getAcceptedIssuers() { return null; }
    };
  }
  void cookie(Cookie cookie) {
    cookie.setHttpOnly(false);
    cookie.setSecure(false);
  }
}
`,
  "fixture.go": `package main

import (
\t"crypto/tls"
\t"database/sql"
\t"fmt"
\t"math/rand"
\t"net/http"
\t"os/exec"
)

func shell(name string) {
\texec.Command("sh", "-c", "git log "+name)
\texec.Command("bash", "-c", fmt.Sprintf("git log %s", name))
}

func query(db *sql.DB, name string) {
\tdb.Query(fmt.Sprintf("SELECT * FROM users WHERE n = '%s'", name))
\tdb.Exec("DELETE FROM users WHERE n = '" + name + "'")
}

func random() {
\tsessionToken := rand.Intn(1 << 30)
\tapiKey := rand.Int63()
\t_, _ = sessionToken, apiKey
}

func tlsConfig() *tls.Config { return &tls.Config{InsecureSkipVerify: true} }

func cookie() *http.Cookie {
\treturn &http.Cookie{Name: "sid", Value: "x", HttpOnly: false, Secure: false}
}
`,
  "fixture.py": `import os
import random
import ssl
import subprocess

import jwt
import requests


def dynamic(name):
    eval(name)
    exec(name)


def shell(name):
    os.system(f"git log {name}")
    subprocess.run(f"git log {name}", shell=True)


def sql(cur, name):
    cur.execute(f"SELECT * FROM users WHERE n = '{name}'")
    cur.execute("DELETE FROM users WHERE n = '%s'" % name)


def random_secret():
    session_token = random.random()
    api_key = random.randint(0, 1 << 30)
    return session_token, api_key


def tls(url):
    requests.get(url, verify=False)
    ctx = ssl._create_unverified_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def cookie(response):
    response.set_cookie("sid", "x", httponly=False, secure=False)


def token(t, key):
    jwt.decode(t, key, options={"verify_signature": False})
`,
  "fixture.rb": `require "openssl"

def dynamic(src)
  eval(src)
  instance_eval(src)
end

def shell(name)
  system("git log #{name}")
  \`git log #{name}\`
end

def sql(conn, name)
  conn.execute("SELECT * FROM users WHERE n = '#{name}'")
  User.where("name = '#{name}'")
end

def random_secret
  session_token = rand(1 << 30)
  api_key = Random.rand(1 << 30)
  [session_token, api_key]
end

def tls(http)
  http.verify_mode = OpenSSL::SSL::VERIFY_NONE
end

def cookie(cookies)
  cookies[:sid] = { value: "x", httponly: false, secure: false }
end

def token(t, key)
  JWT.decode(t, key, false)
end
`,
  "fixture.ts": `import { execSync } from "node:child_process";

export function all(name: string, db: any, jwt: any, t: string) {
  eval(name);
  execSync(\`git log \${name}\`);
  db.query(\`SELECT * FROM users WHERE n = '\${name}'\`);
  const sessionToken = Math.random();
  jwt.decode(t, { complete: true });
  const agent = { rejectUnauthorized: false };
  const cookie = { httpOnly: false, secure: false };
  return { sessionToken, agent, cookie };
}
`,
};

const TRUE_NEGATIVES: Record<string, string> = {
  "Fixture.java": `import java.sql.*;
import java.security.SecureRandom;
import javax.net.ssl.*;
import javax.servlet.http.Cookie;
import javax.script.ScriptEngine;

public class Fixture {
  void sql(Statement st, Connection c, String name) throws Exception {
    st.executeQuery("SELECT * FROM users");
    PreparedStatement ps = c.prepareStatement("SELECT * FROM t WHERE id = ?");
    ps.setString(1, name);
  }
  void shell() throws Exception {
    Runtime.getRuntime().exec("git log");
    new ProcessBuilder("git", "log").start();
  }
  void dynamic(ScriptEngine e) throws Exception { e.eval("1 + 1"); }
  void random() {
    int retryDelay = (int) (Math.random() * 100);
    java.util.Random r = new java.util.Random();
    long jitter = r.nextLong();
    SecureRandom secureRandom = new SecureRandom();
    long apiKey = secureRandom.nextLong();
  }
  void tls(HttpsURLConnection conn) {
    conn.setHostnameVerifier(new HostnameVerifier() {
      public boolean verify(String hostname, SSLSession session) {
        return hostname.equals(session.getPeerHost());
      }
    });
  }
  void cookie(Cookie cookie) {
    cookie.setHttpOnly(true);
    cookie.setSecure(true);
  }
}
`,
  "fixture.go": `package main

import (
\t"crypto/tls"
\t"database/sql"
\t"math/rand"
\t"net/http"
\t"os/exec"
)

func shell(name string) {
\texec.Command("git", "log", name)
\texec.Command("sh", "-c", "git log")
}

func query(db *sql.DB, name string) {
\tdb.Query("SELECT * FROM users WHERE n = ?", name)
\tdb.Exec("DELETE FROM users WHERE n = $1", name)
}

func random() {
\tretryDelay := rand.Intn(100)
\tjitter := rand.Int63()
\t_, _ = retryDelay, jitter
}

func tlsConfig() *tls.Config {
\treturn &tls.Config{InsecureSkipVerify: false, MinVersion: tls.VersionTLS12}
}

func cookie() *http.Cookie {
\treturn &http.Cookie{Name: "sid", Value: "x", HttpOnly: true, Secure: true}
}
`,
  "fixture.py": `import os
import random
import ssl
import subprocess

import jwt
import requests


def dynamic():
    eval("1 + 1")
    exec("x = 1")


def shell(name):
    os.system("git log")
    subprocess.run(["git", "log", name], shell=False)


def sql(cur, name):
    cur.execute("SELECT * FROM users WHERE n = %s", (name,))
    cur.execute("DELETE FROM users")


def random_secret():
    retry_delay = random.random()
    jitter = random.randint(0, 100)
    return retry_delay, jitter


def tls(url):
    requests.get(url, verify=True)
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def cookie(response):
    response.set_cookie("sid", "x", httponly=True, secure=True)


def token(t, key):
    jwt.decode(t, key, algorithms=["HS256"])
`,
  "fixture.rb": `require "openssl"

def dynamic
  eval("1 + 1")
end

def shell
  system("git log")
  \`git log\`
  system("git", "log")
end

def sql(conn, name)
  conn.execute("SELECT * FROM users")
  User.where("name = ?", name)
  User.where(name: name)
end

def random_secret
  retry_delay = rand(100)
  jitter = Random.rand(100)
  [retry_delay, jitter]
end

def tls(http)
  http.verify_mode = OpenSSL::SSL::VERIFY_PEER
end

def cookie(cookies)
  cookies[:sid] = { value: "x", httponly: true, secure: true }
end

def token(t, key)
  JWT.decode(t, key, true, { algorithm: "HS256" })
end
`,
  "fixture.ts": `import { execSync } from "node:child_process";

export function all(name: string, db: any) {
  eval("1 + 1");
  execSync("git log");
  db.query("SELECT * FROM users WHERE n = $1", [name]);
  const retryDelay = Math.random();
  const agent = { rejectUnauthorized: true };
  const cookie = { httpOnly: true, secure: true };
  return { retryDelay, agent, cookie };
}
`,
};

interface Hit {
  check_id?: string;
  path?: string;
  start?: { line?: number };
}

describe.skipIf(!OPENGREP)("rules/review.yaml — every rule fires on real code", () => {
  let dir: string;
  let hits: Hit[];
  let errors: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ll-facts-rules-"));
    for (const [side, files] of [
      ["tp", TRUE_POSITIVES],
      ["tn", TRUE_NEGATIVES],
    ] as const) {
      for (const [name, source] of Object.entries(files)) {
        const path = join(dir, side, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source, "utf8");
      }
    }
    // `opengrepArgs` is PRODUCTION's argument list, imported rather than
    // retyped. It used to be spelled out here — with `--no-rewrite-rule-ids`,
    // which `extractPatterns` did not pass — so this suite was green against an
    // invocation no shipped code ever made, and the rule ids the corpus
    // actually saw carried the config's absolute path.
    const result = spawnSync(OPENGREP as string, opengrepArgs(RULES, ["."]), {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
    const parsed = JSON.parse(result.stdout) as {
      results?: Hit[];
      errors?: { message?: string; type?: string }[];
    };
    hits = parsed.results ?? [];
    errors = (parsed.errors ?? []).map((e) => e.message ?? e.type ?? "unknown");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** The bug that shipped: a config error, an empty finding list, a green run. */
  it("loads the whole ruleset with no config or parse error", () => {
    expect(errors).toEqual([]);
  });

  it("fires at least once for EVERY rule in the file", () => {
    const fired = new Set(hits.map((h) => h.check_id));
    const dead = ruleIds().filter((id) => !fired.has(id));
    expect(dead, "a rule that never fires reads as coverage and is not").toEqual([]);
  });

  it("fires on NOTHING in the near-miss tree", () => {
    const misfires = hits
      .filter((h) => (h.path ?? "").includes("tn/"))
      .map((h) => `${h.check_id} @ ${h.path}:${h.start?.line}`);
    expect(misfires, "the parameterised / literal / non-secret spelling must stay quiet").toEqual(
      [],
    );
  });
});

/**
 * The rule id is IDENTITY, not decoration — `fingerprint()` hashes it.
 *
 * Production shipped without `--no-rewrite-rule-ids`, so every emitted rule
 * read `Users.clifton.work.lastlight.packages.code-facts.rules.lastlight-…`:
 * the host's absolute path, dot-separated, inside a document that is read into
 * a model prompt — and, worse, hashed into the fingerprint, so one hit had two
 * identities depending on whether the run happened in a checkout or in
 * `/opt/lastlight/`. Dedup and suppression are keyed on that hash.
 *
 * This asserts the shape at the OUTPUT boundary (`patterns.findings[].rule`),
 * not on the flag, because the flag is a means and the id is the contract.
 */
describe.skipIf(!OPENGREP)("patterns — the emitted rule id is path-free", () => {
  let fixture: ReturnType<typeof makeFixture>;
  afterAll(() => fixture?.cleanup());

  it("never spells a rule with a path separator or the config's own directories", () => {
    // Ruby SQL-by-interpolation: a true positive of the shipped ruleset that
    // the corpus sweep found for real in discourse's `topic.rb`.
    fixture = makeFixture(
      "ruleid",
      { message: "base", files: { "app/models/topic.rb": `class Topic\nend\n` } },
      {
        message: "head",
        files: {
          "app/models/topic.rb": `class Topic\n  def self.by_name(conn, name)\n    conn.execute("SELECT * FROM topics WHERE name = '#{name}'")\n  end\nend\n`,
        },
      },
    );

    const document = runExtractor({
      extractor: "patterns",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      // gitleaks is deliberately left unresolved: this claim is about opengrep's
      // ids, and the assertion must not depend on a second binary being present.
      env: { PATH: "", LASTLIGHT_OPENGREP_BIN: OPENGREP as string },
    }).document as unknown as PatternsDocument;

    const rules = document.findings.filter((f) => f.tool === "opengrep").map((f) => f.rule);
    expect(rules.length, "the fixture must actually trip a rule, or this asserts nothing").
      toBeGreaterThan(0);
    expect(
      rules.filter((r) => r.includes(sep) || r.includes("/") || r.includes("lastlight.packages")),
      "a rewritten id leaks the host's filesystem AND changes the fingerprint between environments",
    ).toEqual([]);
    // The id is the one written in `rules/review.yaml`, verbatim.
    expect(rules).toContain("lastlight-sql-from-interpolation-ruby");
  });
});
