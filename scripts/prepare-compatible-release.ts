import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const COMPATIBLE_PATCH_OFFSET = 1000;

export function compatibleVersionFor(upstreamTag: string): string {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(upstreamTag.trim());
  if (!match) throw new Error(`Expected a stable upstream tag such as v6.1.10, received ${upstreamTag}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + COMPATIBLE_PATCH_OFFSET}`;
}

function replaceExactly(path: string, pattern: RegExp, replacement: string): void {
  const source = readFileSync(path, "utf8");
  const matches = source.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(`${path} must contain exactly one compatible version target; found ${matches?.length ?? 0}`);
  }
  writeFileSync(path, source.replace(pattern, replacement));
}

export function prepareCompatibleRelease(root: string, upstreamTag: string): string {
  const version = compatibleVersionFor(upstreamTag);
  for (const relativePath of ["package.json", "launcher/package.json"]) {
    const path = resolve(root, relativePath);
    const packageJson = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    packageJson.version = version;
    writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  replaceExactly(
    resolve(root, "src/version.ts"),
    /^export const VERSION = "\d+\.\d+\.\d+";$/m,
    `export const VERSION = "${version}";`,
  );
  replaceExactly(
    resolve(root, "scripts/install.sh"),
    /^VERSION="\$\{CODEX_CHATGPT_WEB_VERSION:-\d+\.\d+\.\d+\}"$/m,
    `VERSION="\${CODEX_CHATGPT_WEB_VERSION:-${version}}"`,
  );

  for (const relativePath of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"]) {
    const path = resolve(root, relativePath);
    const source = readFileSync(path, "utf8");
    const updated = source
      .replaceAll(/\/releases\/download\/v\d+\.\d+\.\d+\/codex-web-gpt-\d+\.\d+\.\d+-/g, `/releases/download/v${version}/codex-web-gpt-${version}-`);
    if (updated === source) throw new Error(`${path} has no versioned release downloads to update`);
    writeFileSync(path, updated);
  }
  return version;
}

if (import.meta.main) {
  const upstreamTag = process.argv[2];
  if (!upstreamTag) throw new Error("Usage: bun run scripts/prepare-compatible-release.ts <upstream-tag>");
  process.stdout.write(`${prepareCompatibleRelease(resolve(import.meta.dir, ".."), upstreamTag)}\n`);
}
