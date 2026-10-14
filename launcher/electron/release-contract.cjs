const UPDATE_REPOSITORY = "fredxie07/codex-chatgpt-web";
const RELEASE_CONTRACT_ASSET = "release-contract.json";
const REQUIRED_RELEASE_FEATURES = Object.freeze(["existing-chrome-auth-v1"]);

function createReleaseContract(version) {
  const normalized = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`Invalid release-contract version: ${version}`);
  }
  return {
    schemaVersion: 1,
    version: normalized,
    features: [...REQUIRED_RELEASE_FEATURES],
  };
}

function validateReleaseContract(contents, expectedVersion) {
  let contract;
  try {
    contract = JSON.parse(String(contents));
  } catch {
    throw new Error(`${RELEASE_CONTRACT_ASSET} is not valid JSON`);
  }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error(`${RELEASE_CONTRACT_ASSET} must contain an object`);
  }
  if (contract.schemaVersion !== 1) {
    throw new Error(`${RELEASE_CONTRACT_ASSET} has an unsupported schema version`);
  }
  if (contract.version !== expectedVersion) {
    throw new Error(`${RELEASE_CONTRACT_ASSET} version ${contract.version} does not match release version ${expectedVersion}`);
  }
  if (!Array.isArray(contract.features) || contract.features.some(feature => typeof feature !== "string")) {
    throw new Error(`${RELEASE_CONTRACT_ASSET} has an invalid features list`);
  }
  for (const feature of REQUIRED_RELEASE_FEATURES) {
    if (!contract.features.includes(feature)) {
      throw new Error(`${RELEASE_CONTRACT_ASSET} is missing required feature ${feature}`);
    }
  }
  return {
    schemaVersion: 1,
    version: contract.version,
    features: [...contract.features],
  };
}

module.exports = {
  RELEASE_CONTRACT_ASSET,
  REQUIRED_RELEASE_FEATURES,
  UPDATE_REPOSITORY,
  createReleaseContract,
  validateReleaseContract,
};
