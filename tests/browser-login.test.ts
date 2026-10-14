import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  parseChromeDevToolsActivePort,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login starts with normal Chrome and captures state in a headed Keychain-aware context", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing-session login opens regular Chrome without replacing its user-data directory", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-existing-chrome-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let browserReady = false;
    const error = await captureSystemBrowserLogin(config, {
      continuation: Promise.resolve(),
      timeoutMs: 250,
      chromeUserDataDir: join(root, "Chrome"),
      onBrowserReady: () => { browserReady = true; },
    }).then(() => undefined, caught => caught as Error);
    expect(error?.message).toContain("Remote Debugging is not enabled");

    for (let attempt = 0; attempt < 100 && !existsSync(argsLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(browserReady).toBe(true);
    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("chrome://inspect/#remote-debugging");
    expect(launches[0]).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(launches[0]).not.toContain("--user-data-dir=");
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome DevTools active-port parsing accepts only a loopback port and browser path", () => {
  expect(parseChromeDevToolsActivePort("9222\n/devtools/browser/abc-123\n"))
    .toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
  expect(() => parseChromeDevToolsActivePort("0\n/devtools/browser/abc\n"))
    .toThrow("invalid remote-debugging port");
  expect(() => parseChromeDevToolsActivePort("9222\nws://attacker.example/browser\n"))
    .toThrow("invalid remote-debugging connection details");
});

test("existing-session login waits for Chrome to enable remote debugging after Continue", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-delayed-chrome-port-"));
  const executable = join(root, "fake-chrome");
  const chromeUserDataDir = join(root, "Chrome");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  mkdirSync(chromeUserDataDir, { recursive: true });
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    const delayedPort = setTimeout(() => {
      writeFileSync(join(chromeUserDataDir, "DevToolsActivePort"), "9\n/devtools/browser/delayed\n");
    }, 100);
    const error = await captureSystemBrowserLogin(config, {
      continuation: Promise.resolve(),
      timeoutMs: 1_000,
      chromeUserDataDir,
    }).then(() => undefined, caught => caught as Error);
    clearTimeout(delayedPort);
    expect(error?.message).not.toContain("Remote Debugging is not enabled");
    expect(error?.message).toContain("Chrome did not approve the connection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey storage capture excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
