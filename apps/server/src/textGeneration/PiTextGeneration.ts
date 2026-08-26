/** Pure text generation through one-shot `pi -p` invocations. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type PiSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolvePiThinkingLevel } from "../provider/Layers/PiRpcClient.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;
type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const isTextGenerationError = Schema.is(TextGenerationError);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: Parameters<
      TextGeneration.TextGeneration["Service"]["generateThreadTitle"]
    >[0]["modelSelection"];
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const thinking = resolvePiThinkingLevel(input.modelSelection);
      const args = [
        "-p",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--model",
        input.modelSelection.model,
        ...(thinking ? ["--thinking", thinking] : []),
        `${input.prompt}\n\nRespond ONLY with the requested JSON object. No markdown or prose.`,
      ];
      const executable = settings.binaryPath || "pi";
      const spawn = yield* resolveSpawnCommand(executable, args, {
        env: environment,
        extendEnv: true,
      });
      const raw = yield* spawner
        .string(
          ChildProcess.make(spawn.command, spawn.args, {
            cwd: input.cwd,
            env: environment,
            extendEnv: true,
            shell: spawn.shell,
          }),
        )
        .pipe(
          Effect.timeoutOption(PI_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "Pi text generation timed out.",
                  }),
                ),
              onSome: (value) => Effect.succeed(value.trim()),
            }),
          ),
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: input.operation,
                  detail: "Pi text generation invocation failed.",
                  cause,
                }),
          ),
        );
      if (!raw) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Pi returned empty text generation output.",
        });
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(raw),
      ).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
