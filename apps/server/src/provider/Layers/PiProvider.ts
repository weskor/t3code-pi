import {
  type PiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  extractAvailableModels,
  makePiRpcTransport,
  piModelInfoToServerModel,
} from "./PiRpcClient.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const DISCOVERY_TIMEOUT_MS = 15_000;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const binaryPath = (settings: PiSettings): string => settings.binaryPath || "pi";

const runPiVersion = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const executable = binaryPath(settings);
    const spawn = yield* resolveSpawnCommand(executable, ["--version"], {
      env: environment,
      extendEnv: true,
    });
    return yield* spawnAndCollect(
      executable,
      ChildProcess.make(spawn.command, spawn.args, {
        env: environment,
        extendEnv: true,
        shell: spawn.shell,
      }),
    );
  });

export const discoverPiModels = Effect.fn("discoverPiModels")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* makePiRpcTransport({
        binaryPath: binaryPath(settings),
        args: ["--mode", "rpc", "--no-session"],
        cwd,
        env: environment,
        onExit: Effect.void,
      });
      const response = yield* transport.request(
        { type: "get_available_models" },
        "pi-provider-models",
        DISCOVERY_TIMEOUT_MS,
      );
      return extractAvailableModels(response).map((model, index) =>
        piModelInfoToServerModel(model, index === 0),
      );
    }),
  ).pipe(
    Effect.timeoutOption(DISCOVERY_TIMEOUT_MS),
    Effect.map(Option.getOrElse(() => [] as ReadonlyArray<ServerProviderModel>)),
    Effect.catchCause((cause) =>
      Effect.logWarning("pi.provider.model-discovery-failed", { cause }).pipe(
        Effect.as([] as ReadonlyArray<ServerProviderModel>),
      ),
    ),
  );
});

export const makePendingPiProvider = Effect.fn("makePendingPiProvider")(function* (
  settings: PiSettings,
) {
  const checkedAt = yield* nowIso;
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: [],
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Pi availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled for this provider instance.",
        },
  });
});

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = yield* nowIso;
  if (!settings.enabled) return yield* makePendingPiProvider(settings);

  const versionProbe = yield* runPiVersion(settings, environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const cause = versionProbe.failure;
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(cause)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute the Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI timed out while running `pi --version`.",
      },
    });
  }

  const result = versionProbe.success.value;
  const version = parseGenericCliVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: detailFromResult(result) ?? "Pi CLI returned an error during health check.",
      },
    });
  }

  const models = yield* discoverPiModels(settings, cwd, environment);
  const authenticated = models.length > 0;
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unknown", type: "pi" },
      ...(authenticated
        ? {}
        : {
            message:
              "Pi is installed but exposes no models. Configure a provider/API key in Pi, then refresh provider status.",
          }),
    },
  });
});