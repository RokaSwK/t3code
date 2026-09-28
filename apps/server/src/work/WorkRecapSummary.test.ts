import { DEFAULT_SERVER_SETTINGS, TextGenerationError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { summarizeWorkRecap } from "./WorkRecapSummary.ts";

const run = (generateWorkRecap: TextGeneration.TextGeneration["Service"]["generateWorkRecap"]) =>
  summarizeWorkRecap({ mode: "daily", facts: "Done in app:\n- Ship refunds (PR merged)" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-work-recap-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.mock(TextGeneration.TextGeneration)({ generateWorkRecap }),
      ),
    ),
  );

it.effect("writes the recap with the text generation model from settings", () =>
  Effect.gen(function* () {
    let seen: TextGeneration.WorkRecapGenerationInput | undefined;
    const result = yield* run((input) => {
      seen = input;
      return Effect.succeed({ summary: "I shipped refunds." });
    });
    expect(result).toEqual({
      summary: "I shipped refunds.",
      model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
    });
    expect(seen).toMatchObject({
      mode: "daily",
      modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    });
  }),
);

it.effect("reports a failed generation as a recap error", () =>
  Effect.gen(function* () {
    const error = yield* run(() =>
      Effect.fail(new TextGenerationError({ operation: "generateWorkRecap", detail: "offline" })),
    ).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "WorkRecapSummaryError", message: "offline" });
  }),
);
