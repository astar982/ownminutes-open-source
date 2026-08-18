export function summarizePhysicalIosDevices(payload) {
  const devices = Array.isArray(payload?.result?.devices) ? payload.result.devices : [];
  return devices
    .filter(
      (device) =>
        device?.hardwareProperties?.platform === "iOS" &&
        device?.hardwareProperties?.reality === "physical" &&
        device?.hardwareProperties?.deviceType === "iPhone",
    )
    .map((device) => ({
      identifier: stringValue(device.identifier),
      hardwareUdid: stringValue(device?.hardwareProperties?.udid),
      name: stringValue(device?.deviceProperties?.name) || "iPhone",
      model: stringValue(device?.hardwareProperties?.marketingName) || "iPhone",
      productType: stringValue(device?.hardwareProperties?.productType),
      osVersion: stringValue(device?.deviceProperties?.osVersionNumber),
      paired: device?.connectionProperties?.pairingState === "paired",
      available:
        device?.connectionProperties?.tunnelState === "connected" ||
        device?.deviceProperties?.ddiServicesAvailable === true,
      developerMode: device?.deviceProperties?.developerModeStatus === "enabled",
    }))
    .filter((device) => device.identifier && device.hardwareUdid);
}

export function selectPhysicalIosDevice(devices, requestedIdentifier = "") {
  const requested = requestedIdentifier.trim();
  if (requested) {
    return devices.find(
      (device) => device.identifier === requested || device.hardwareUdid === requested,
    ) ?? null;
  }
  const available = devices.filter((device) => device.available);
  return available.length === 1 ? available[0] : devices.length === 1 ? devices[0] : null;
}

export function inspectDeviceApiUrl(value) {
  const normalized = value.trim().replace(/\/$/, "");
  if (!normalized) {
    return { configured: false, valid: false, host: null, normalized: "", reason: "missing" };
  }
  try {
    const url = new URL(normalized);
    const host = normalizeHost(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return { configured: true, valid: false, host, normalized, reason: "origin-required" };
    }
    if (url.protocol !== "https:") {
      return { configured: true, valid: false, host, normalized, reason: "https-required" };
    }
    if (isNonPublicHost(host)) {
      return { configured: true, valid: false, host, normalized, reason: "device-unreachable-host" };
    }
    return { configured: true, valid: true, host, normalized, reason: null };
  } catch {
    return { configured: true, valid: false, host: null, normalized, reason: "invalid-url" };
  }
}

export function evaluateDeviceAcceptancePreflight({
  apiUrl,
  device,
  developmentIdentityReady,
  gitClean,
  managedSourceTree,
  serverReachable,
  teamId,
}) {
  const checks = {
    teamId: /^[A-Z0-9]{10}$/.test(teamId || ""),
    developmentIdentity: developmentIdentityReady === true,
    apiUrl: apiUrl.valid === true,
    serverReachable: serverReachable === true,
    deviceDetected: Boolean(device),
    devicePaired: device?.paired === true,
    deviceAvailable: device?.available === true,
    developerMode: device?.developerMode === true,
    managedSourceTree: managedSourceTree === true,
    cleanGit: gitClean === true,
  };
  return {
    checks,
    failed: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name),
    ready: Object.values(checks).every(Boolean),
  };
}

export function safeDeviceSummary(device) {
  if (!device) return null;
  return {
    name: device.name,
    model: device.model,
    productType: device.productType,
    osVersion: device.osVersion,
    paired: device.paired,
    available: device.available,
    developerMode: device.developerMode,
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHost(value) {
  return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isNonPublicHost(host) {
  if (
    ["localhost", "0.0.0.0", "::", "::1"].includes(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^(?:127|10)\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) {
    return true;
  }
  return /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(host);
}
