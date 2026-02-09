// FreeClaw service constants for FreeBSD rc.d
export const GATEWAY_RCD_SERVICE_NAME = "freeclaw_gateway";
export const GATEWAY_SERVICE_MARKER = "freeclaw";
export const GATEWAY_SERVICE_KIND = "gateway";
export const NODE_RCD_SERVICE_NAME = "freeclaw_node";
export const NODE_SERVICE_MARKER = "freeclaw";
export const NODE_SERVICE_KIND = "node";

export function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return null;
  }
  return trimmed;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `_${normalized}` : "";
}

export function resolveGatewayRcdServiceName(profile?: string): string {
  const suffix = resolveGatewayProfileSuffix(profile);
  if (!suffix) {
    return GATEWAY_RCD_SERVICE_NAME;
  }
  return `freeclaw_gateway${suffix}`;
}

export function formatGatewayServiceDescription(params?: {
  profile?: string;
  version?: string;
}): string {
  const profile = normalizeGatewayProfile(params?.profile);
  const version = params?.version?.trim();
  const parts: string[] = [];
  if (profile) {
    parts.push(`profile: ${profile}`);
  }
  if (version) {
    parts.push(`v${version}`);
  }
  if (parts.length === 0) {
    return "FreeClaw Gateway";
  }
  return `FreeClaw Gateway (${parts.join(", ")})`;
}

export function resolveNodeRcdServiceName(): string {
  return NODE_RCD_SERVICE_NAME;
}

export function formatNodeServiceDescription(params?: { version?: string }): string {
  const version = params?.version?.trim();
  if (!version) {
    return "FreeClaw Node Host";
  }
  return `FreeClaw Node Host (v${version})`;
}
