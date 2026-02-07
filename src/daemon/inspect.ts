import fs from "node:fs/promises";
import path from "node:path";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayRcdServiceName,
} from "./constants.js";

export type ExtraGatewayService = {
  platform: "freebsd";
  label: string;
  detail: string;
  scope: "user" | "system";
  marker?: "freeclaw" | "clawdbot" | "moltbot";
  legacy?: boolean;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

const EXTRA_MARKERS = ["freeclaw", "clawdbot", "moltbot"] as const;

export function renderGatewayServiceCleanupHints(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const profile = env.FREECLAW_PROFILE;
  const serviceName = resolveGatewayRcdServiceName(profile);
  return [
    `service ${serviceName} stop`,
    `rm /usr/local/etc/rc.d/${serviceName}`,
  ];
}

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

type Marker = (typeof EXTRA_MARKERS)[number];

function detectMarker(content: string): Marker | null {
  const lower = content.toLowerCase();
  for (const marker of EXTRA_MARKERS) {
    if (lower.includes(marker)) {
      return marker;
    }
  }
  return null;
}

function hasGatewayServiceMarker(content: string): boolean {
  const lower = content.toLowerCase();
  const markerKeys = ["freeclaw_service_marker"];
  const kindKeys = ["freeclaw_service_kind"];
  const markerValues = [GATEWAY_SERVICE_MARKER.toLowerCase()];
  const hasMarkerKey = markerKeys.some((key) => lower.includes(key));
  const hasKindKey = kindKeys.some((key) => lower.includes(key));
  const hasMarkerValue = markerValues.some((value) => lower.includes(value));
  return (
    hasMarkerKey &&
    hasKindKey &&
    hasMarkerValue &&
    lower.includes(GATEWAY_SERVICE_KIND.toLowerCase())
  );
}

function isOpenClawGatewayRcdService(name: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) {
    return true;
  }
  const lowerContents = contents.toLowerCase();
  if (!lowerContents.includes("gateway")) {
    return false;
  }
  return name.startsWith("freeclaw");
}

function isIgnoredRcdName(name: string): boolean {
  return name === resolveGatewayRcdServiceName();
}

function isLegacyLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("clawdbot") || lower.includes("moltbot");
}

async function scanRcdDir(params: {
  dir: string;
  scope: "user" | "system";
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(params.dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const name = entry;
    if (isIgnoredRcdName(name)) {
      continue;
    }
    const fullPath = path.join(params.dir, entry);
    let contents = "";
    try {
      contents = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const marker = detectMarker(contents);
    if (!marker) {
      const legacyName = isLegacyLabel(name);
      if (!legacyName) {
        continue;
      }
      results.push({
        platform: "freebsd",
        label: name,
        detail: `rc.d: ${fullPath}`,
        scope: params.scope,
        marker: isLegacyLabel(name) ? "clawdbot" : "moltbot",
        legacy: true,
      });
      continue;
    }
    if (isIgnoredRcdName(name)) {
      continue;
    }
    if (marker === "freeclaw" && isOpenClawGatewayRcdService(name, contents)) {
      continue;
    }
    results.push({
      platform: "freebsd",
      label: name,
      detail: `rc.d: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "freeclaw" || isLegacyLabel(name),
    });
  }

  return results;
}


export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const seen = new Set<string>();
  const push = (svc: ExtraGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(svc);
  };

  try {
    // Scan user rc.d directory
    const home = resolveHomeDir(env);
    const userRcdDir = path.join(home, ".rc.d");
    for (const svc of await scanRcdDir({
      dir: userRcdDir,
      scope: "user",
    })) {
      push(svc);
    }

    if (opts.deep) {
      // Scan system rc.d directories
      for (const dir of ["/etc/rc.d", "/usr/local/etc/rc.d"]) {
        for (const svc of await scanRcdDir({
          dir,
          scope: "system",
        })) {
          push(svc);
        }
      }
    }
  } catch {
    return results;
  }

  return results;
}
