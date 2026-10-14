const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RELEASE_CONTRACT_ASSET,
  REQUIRED_RELEASE_FEATURES,
  UPDATE_REPOSITORY,
  createReleaseContract,
  validateReleaseContract,
} = require("../electron/release-contract.cjs");

test("compatible update channel is pinned to the maintained fork", () => {
  assert.equal(UPDATE_REPOSITORY, "fredxie07/codex-chatgpt-web");
  assert.equal(RELEASE_CONTRACT_ASSET, "release-contract.json");
  assert.deepEqual(REQUIRED_RELEASE_FEATURES, ["existing-chrome-auth-v1"]);
});

test("release contract binds the exact version and required Chrome authorization feature", () => {
  const contract = createReleaseContract("6.2.0");
  assert.deepEqual(validateReleaseContract(`${JSON.stringify(contract)}\n`, "6.2.0"), contract);
  assert.throws(
    () => validateReleaseContract(JSON.stringify({ ...contract, version: "6.2.1" }), "6.2.0"),
    /does not match release version/,
  );
  assert.throws(
    () => validateReleaseContract(JSON.stringify({ ...contract, features: [] }), "6.2.0"),
    /missing required feature existing-chrome-auth-v1/,
  );
  assert.throws(
    () => validateReleaseContract("not json", "6.2.0"),
    /valid JSON/,
  );
});
