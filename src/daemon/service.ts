import type { GatewayServiceRuntime } from "./service-runtime.js";
import {
  installRcdService,
  isRcdServiceEnabled,
  readRcdServiceExecStart,
  readRcdServiceRuntime,
  restartRcdService,
  stopRcdService,
  uninstallRcdService,
} from "./rcd.js";

export type GatewayServiceInstallArgs = {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
};

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  stop: (args: {
    env?: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  restart: (args: {
    env?: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  isLoaded: (args: { env?: Record<string, string | undefined> }) => Promise<boolean>;
  readCommand: (env: Record<string, string | undefined>) => Promise<{
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    sourcePath?: string;
  } | null>;
  readRuntime: (env: Record<string, string | undefined>) => Promise<GatewayServiceRuntime>;
};

/** FreeBSD rc.d service — the only supported service backend. */
export function resolveGatewayService(): GatewayService {
  return {
    label: "rc.d",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: async (args) => {
      await installRcdService(args);
    },
    uninstall: async (args) => {
      await uninstallRcdService(args);
    },
    stop: async (args) => {
      await stopRcdService({
        stdout: args.stdout,
        env: args.env,
      });
    },
    restart: async (args) => {
      await restartRcdService({
        stdout: args.stdout,
        env: args.env,
      });
    },
    isLoaded: async (args) => isRcdServiceEnabled(args),
    readCommand: readRcdServiceExecStart,
    readRuntime: async (env) => await readRcdServiceRuntime(env),
  };
}
