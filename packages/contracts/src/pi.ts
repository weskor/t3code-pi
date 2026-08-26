import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";
import { makeProviderSettingsSchema } from "./settings.ts";

/**
 * Pi is configured per provider instance. The binary defaults to `pi`; model
 * inventory is discovered live from `pi --mode rpc` instead of being stored
 * in T3 settings.
 */
export const PiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("pi")),
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding-agent binary used by this instance.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
  },
  { order: ["binaryPath"] },
);
export type PiSettings = typeof PiSettings.Type;
