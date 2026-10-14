const fs = require("node:fs");
const path = require("node:path");
const { RELEASE_CONTRACT_ASSET, createReleaseContract } = require("../electron/release-contract.cjs");

const [version, outputDirectory] = process.argv.slice(2);
if (!version || !outputDirectory) {
  throw new Error("Usage: node write-release-contract.cjs <version> <output-directory>");
}
fs.mkdirSync(outputDirectory, { recursive: true });
const destination = path.join(outputDirectory, RELEASE_CONTRACT_ASSET);
fs.writeFileSync(destination, `${JSON.stringify(createReleaseContract(version), null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
process.stdout.write(`${destination}\n`);
