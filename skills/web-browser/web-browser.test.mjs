import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { consumeLocalFlag, resolveConnection } from "./scripts/cdp.js";

const root = dirname(fileURLToPath(import.meta.url));
const scripts = join(root, "scripts");

test("web-browser is a dependency-free Bun skill", () => {
  assert.ok(!existsSync(join(scripts, "package.json")));
  assert.ok(!existsSync(join(scripts, "package-lock.json")));

  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  assert.match(skill, /^compatibility: .*Bun 1\.3\+/m);

  const cdp = readFileSync(join(scripts, "cdp.js"), "utf8");
  assert.doesNotMatch(cdp, /from ["']ws["']/);
  assert.match(cdp, /Authorization: `Bearer \$\{apiKey\}`/);

  const executableScripts = readdirSync(scripts)
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, readFileSync(join(scripts, name), "utf8")])
    .filter(([, source]) => source.startsWith("#!"));

  assert.ok(executableScripts.length > 0);
  for (const [name, source] of executableScripts) {
    assert.equal(source.split("\n", 1)[0], "#!/usr/bin/env bun", name);
  }
});

test("web-browser supports safe headless Chrome launches", () => {
  const start = readFileSync(join(scripts, "start.js"), "utf8");

  assert.match(start, /const headless = args\.has\("--headless"\);/);
  assert.match(start, /runningExtensionsDisabled === headless/);
  assert.match(start, /chromeArgs\.push\("--headless", "--disable-extensions"\);/);
  assert.match(start, /extensionsDisabled: headless,/);
  assert.match(start, /args\.has\("--local"\)/);
});

test("web-browser removes --local before command-specific argument parsing", () => {
  const argv = ["node", "nav.js", "https://example.com", "--new", "--local"];
  assert.equal(consumeLocalFlag(argv), true);
  assert.deepEqual(argv, ["node", "nav.js", "https://example.com", "--new"]);
});

test("web-browser prefers CDP_ENDPOINT unless --local is used", () => {
  assert.deepEqual(
    resolveConnection(
      {
        CDP_ENDPOINT: "https://browser.example.test",
        CDP_API_KEY: "secret",
        BROWSER_DEBUG_PORT: "9333",
      },
      false,
    ),
    {
      external: true,
      url: "https://browser.example.test/json/version",
      apiKey: "secret",
    },
  );

  assert.deepEqual(
    resolveConnection(
      {
        CDP_ENDPOINT: "https://browser.example.test/cdp",
        CDP_API_KEY: "secret",
      },
      false,
    ),
    {
      external: true,
      url: "https://browser.example.test/cdp/json/version",
      apiKey: "secret",
    },
  );

  assert.deepEqual(
    resolveConnection(
      {
        CDP_ENDPOINT: "https://browser.example.test/cdp/",
      },
      false,
    ),
    {
      external: true,
      url: "https://browser.example.test/cdp/json/version",
      apiKey: null,
    },
  );

  assert.deepEqual(
    resolveConnection(
      {
        CDP_ENDPOINT: "https://browser.example.test/cdp/json/version?token=1",
      },
      false,
    ),
    {
      external: true,
      url: "https://browser.example.test/cdp/json/version?token=1",
      apiKey: null,
    },
  );

  assert.deepEqual(
    resolveConnection(
      {
        CDP_ENDPOINT: "wss://browser.example.test/devtools/browser/1",
      },
      false,
    ),
    {
      external: true,
      url: "wss://browser.example.test/devtools/browser/1",
      apiKey: null,
    },
  );

  assert.deepEqual(
    resolveConnection(
      {
        CDP_ENDPOINT: "https://browser.example.test",
        BROWSER_DEBUG_HOST: "127.0.0.1",
        BROWSER_DEBUG_PORT: "9333",
      },
      true,
    ),
    {
      external: false,
      url: "http://127.0.0.1:9333/json/version",
      port: 9333,
    },
  );
});
