import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type BrowserContext, type BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_COMPOSER_SELECTOR,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  extraHighAvailable: boolean;
  proAvailable: boolean;
}

export type BrowserLoginStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface SystemBrowserLoginCaptureMarker {
  version: 1;
  captureComplete: true;
  source: "user-approved-existing-chrome";
  capturedAt: string;
}

export interface SystemBrowserLoginCapture {
  storageState: BrowserLoginStorageState;
  marker: SystemBrowserLoginCaptureMarker;
}

interface SystemBrowserLoginOptions {
  continuation: Promise<void>;
  timeoutMs?: number;
  onBrowserReady?: () => void;
  /** Test/enterprise override. The launcher uses Chrome's real stable user-data root by default. */
  chromeUserDataDir?: string;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  extraHighAvailable?: boolean;
  proAvailable?: boolean;
}

const SYSTEM_LOGIN_TIMEOUT_MS = 10 * 60_000;
const CHROME_REMOTE_DEBUGGING_START_TIMEOUT_MS = 60_000;
const LOGIN_STORAGE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;
const CHATGPT_ORIGIN = new URL(CHATGPT_TEMPORARY_CHAT_URL).origin;
const CHROME_REMOTE_DEBUGGING_URL = "chrome://inspect/#remote-debugging";
const CHATGPT_COMPOSER_POLL_MS = 200;

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: unknown;
}

interface CdpEvaluationResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string };
}

export function defaultChromeUserDataDir(
  platform = process.platform,
  userHome = homedir(),
): string {
  if (platform !== "darwin") throw new Error("Existing Chrome session import is currently supported only on macOS");
  return join(userHome, "Library", "Application Support", "Google", "Chrome");
}

export function parseChromeDevToolsActivePort(value: string): string {
  const [rawPort, rawPath, ...trailing] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (trailing.length > 0 || !rawPort || !/^\d+$/.test(rawPort) || !rawPath || !rawPath.startsWith("/")) {
    throw new Error("Chrome returned invalid remote-debugging connection details");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Chrome returned an invalid remote-debugging port");
  }
  return `ws://127.0.0.1:${port}${rawPath}`;
}

async function waitForChromeDevToolsActivePort(activePortPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return parseChromeDevToolsActivePort(readFileSync(activePortPath, "utf8"));
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (existsSync(activePortPath) && lastError instanceof Error) throw lastError;
  throw new Error(
    "Chrome Remote Debugging is not enabled. In your regular Chrome open "
      + "chrome://inspect/#remote-debugging, turn on ‘Allow remote debugging for this browser instance’, "
      + "wait until Chrome shows that remote debugging is enabled, then try again.",
  );
}

function allowedLoginStorageHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")) return false;
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (parsed.hostname !== hostname
      || parsed.host !== hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) return false;
  } catch {
    return false;
  }
  return LOGIN_STORAGE_ROOT_DOMAINS.some(root => hostname === root || hostname.endsWith(`.${root}`));
}

export function sanitizeBrowserLoginStorageState(
  storageState: BrowserLoginStorageState,
): BrowserLoginStorageState {
  return {
    cookies: storageState.cookies
      .filter(cookie => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
        && allowedLoginStorageHost(cookie.domain.replace(/^\.+/, "")))
      .map(cookie => ({ ...cookie })),
    origins: storageState.origins
      .filter(origin => origin.origin === CHATGPT_ORIGIN)
      .map(origin => ({
        origin: origin.origin,
        localStorage: origin.localStorage.map(item => ({ ...item })),
      })),
  };
}

class CdpConnection {
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => { void this.handleMessage(event.data); });
    socket.addEventListener("close", () => this.failPending(new Error("Chrome remote-debugging connection closed")));
    socket.addEventListener("error", () => this.failPending(new Error("Chrome remote-debugging connection failed")));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error(
        "Chrome did not approve the connection. Enable Remote Debugging in Chrome and approve the access prompt.",
      ));
      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for Chrome to approve the remote-debugging connection")),
        timeoutMs,
      );
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    return new CdpConnection(socket);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Blob) text = await raw.text();
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else if (ArrayBuffer.isView(raw)) text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    else return;
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id!);
    if (!pending) return;
    this.pending.delete(message.id!);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "Chrome DevTools command failed"));
    else pending.resolve(message.result);
  }

  private failPending(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chrome remote-debugging connection is not open"));
    }
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.failPending(new Error("Chrome remote-debugging connection was closed"));
    try { this.socket.close(); } catch {}
  }
}

function evaluationValue<T>(result: unknown, label: string): T {
  const evaluated = result as CdpEvaluationResult;
  if (evaluated?.exceptionDetails) {
    throw new Error(`${label}: ${evaluated.exceptionDetails.text || "page evaluation failed"}`);
  }
  return evaluated?.result?.value as T;
}

async function captureApprovedChromeState(
  webSocketUrl: string,
  timeoutMs: number,
  verificationUrl: string,
): Promise<BrowserLoginStorageState> {
  const connection = await CdpConnection.connect(webSocketUrl, timeoutMs);
  let targetId: string | undefined;
  try {
    const targets = await connection.send("Target.getTargets") as {
      targetInfos?: Array<{ targetId?: unknown; type?: unknown; url?: unknown; browserContextId?: unknown }>;
    };
    const target = targets?.targetInfos?.find(candidate => candidate.type === "page" && candidate.url === verificationUrl);
    if (!target || typeof target.targetId !== "string" || !target.targetId) {
      throw new Error("The ChatGPT verification tab is no longer open in the approved Chrome profile");
    }
    targetId = target.targetId;
    const browserContextId = typeof target.browserContextId === "string" ? target.browserContextId : undefined;
    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId?: unknown };
    if (typeof attached?.sessionId !== "string" || !attached.sessionId) {
      throw new Error("Chrome did not expose the ChatGPT verification tab");
    }
    const sessionId = attached.sessionId;
    await connection.send("Runtime.enable", {}, sessionId);
    const deadline = Date.now() + Math.min(timeoutMs, 60_000);
    let lastUrl = CHATGPT_TEMPORARY_CHAT_URL;
    while (true) {
      const result = await connection.send("Runtime.evaluate", {
        expression: `(() => {
          const visible = Array.from(document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}))
            .some(element => {
              const style = getComputedStyle(element);
              const bounds = element.getBoundingClientRect();
              return element.isConnected && bounds.width > 0 && bounds.height > 0
                && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
            });
          return { url: location.href, readyState: document.readyState, composerVisible: visible };
        })()`,
        returnByValue: true,
      }, sessionId);
      const state = evaluationValue<{ url?: unknown; composerVisible?: unknown }>(result, "Could not inspect ChatGPT");
      if (typeof state?.url === "string") lastUrl = state.url;
      if (state?.composerVisible === true) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `The selected Chrome profile is not signed in to ChatGPT or did not reach Temporary Chat (${lastUrl})`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, CHATGPT_COMPOSER_POLL_MS));
    }
    const current = new URL(lastUrl);
    if (current.origin !== CHATGPT_ORIGIN || current.pathname !== "/" || current.searchParams.get("temporary-chat") !== "true") {
      throw new Error(`Chrome left the Temporary Chat verification surface (${lastUrl})`);
    }

    const cookieResult = await connection.send(
      "Storage.getCookies",
      browserContextId ? { browserContextId } : {},
    ) as { cookies?: unknown };
    if (!Array.isArray(cookieResult?.cookies)) throw new Error("Chrome did not return browser cookies");
    const cookies = (cookieResult.cookies as CdpCookie[])
      .filter(cookie => cookie && typeof cookie === "object" && cookie.partitionKey === undefined)
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.session === true ? -1 : (cookie.expires ?? -1),
        httpOnly: cookie.httpOnly === true,
        secure: cookie.secure === true,
        sameSite: cookie.sameSite ?? "Lax",
      }));
    const localStorageResult = await connection.send("Runtime.evaluate", {
      expression: "Object.entries(localStorage).map(([name, value]) => ({ name, value }))",
      returnByValue: true,
    }, sessionId);
    const localStorage = evaluationValue<Array<{ name: string; value: string }>>(
      localStorageResult,
      "Could not read ChatGPT local storage",
    );
    const storageState = sanitizeBrowserLoginStorageState({
      cookies,
      origins: [{ origin: CHATGPT_ORIGIN, localStorage: Array.isArray(localStorage) ? localStorage : [] }],
    });
    if (storageState.cookies.length === 0) {
      throw new Error("The approved Chrome profile contains no ChatGPT/OpenAI cookies");
    }
    return storageState;
  } finally {
    if (targetId) await connection.send("Target.closeTarget", { targetId }).catch(() => {});
    connection.close();
  }
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected);
  return { solAvailable: inspected.solAvailable, extraHighAvailable: inspected.extraHighAvailable, proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.extraHighAvailable === "boolean" ? { extraHighAvailable: marker.extraHighAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export async function captureSystemBrowserLogin(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: SystemBrowserLoginOptions,
): Promise<SystemBrowserLoginCapture> {
  if (process.platform !== "darwin") {
    throw new Error("Existing Chrome session import is currently supported only on macOS");
  }
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  }
  const timeoutMs = options.timeoutMs ?? SYSTEM_LOGIN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Existing Chrome authorization timeout must be a positive finite number");
  }
  const deadline = Date.now() + timeoutMs;
  const remainingTime = () => {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error("Timed out waiting for existing Chrome authorization");
    return remaining;
  };
  const chromeUserDataDir = options.chromeUserDataDir ?? defaultChromeUserDataDir();
  const verificationUrl = `${CHATGPT_TEMPORARY_CHAT_URL}#codex-web-gpt-auth-${randomBytes(16).toString("hex")}`;
  process.stdout.write(
    "In your regular Chrome, confirm ChatGPT is signed in, enable Remote Debugging at "
      + "chrome://inspect/#remote-debugging, then return to Codex Web GPT and choose Continue. "
      + "Approve the Chrome connection prompt when it appears.\n",
  );
  const chrome = spawn(config.chromeExecutablePath, [
    "--new-window",
    CHROME_REMOTE_DEBUGGING_URL,
    verificationUrl,
  ], { detached: true, env: process.env, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    chrome.once("spawn", () => {
      try {
        options.onBrowserReady?.();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    chrome.once("error", reject);
  });
  chrome.unref();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for existing Chrome authorization")),
      remainingTime(),
    );
    timer.unref?.();
    void options.continuation.then(() => {
      clearTimeout(timer);
      resolve();
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const activePortPath = join(chromeUserDataDir, "DevToolsActivePort");
  const webSocketUrl = await waitForChromeDevToolsActivePort(
    activePortPath,
    Math.min(remainingTime(), CHROME_REMOTE_DEBUGGING_START_TIMEOUT_MS),
  );
  const storageState = await captureApprovedChromeState(webSocketUrl, remainingTime(), verificationUrl);
  return {
    storageState,
    marker: {
      version: 1,
      captureComplete: true,
      source: "user-approved-existing-chrome",
      capturedAt: new Date().toISOString(),
    },
  };
}

export async function captureSystemBrowserLoginToFile(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: SystemBrowserLoginOptions,
): Promise<void> {
  const capture = await captureSystemBrowserLogin(config, options);
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  rmSync(markerPath, { force: true });
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(capture.storageState)}\n`);
  atomicWriteFile(markerPath, `${JSON.stringify(capture.marker)}\n`);
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], { env: process.env, stdio: "ignore" });
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    try {
      await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
    } catch {
      throw new Error("The authenticated ChatGPT page did not produce a visible composer");
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    const state = await context.storageState();

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      solAvailable: inspected.solAvailable,
      extraHighAvailable: inspected.extraHighAvailable === true,
      proAvailable: inspected.proAvailable,
    };
  } finally {
    await context.close();
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
