import { WorkRecapSummaryError, type WorkRecapSummaryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

/** Writes the recap's prose with the text generation model chosen in settings. */
export const summarizeWorkRecap = Effect.fn("WorkRecap.summarize")(
  function* (input: WorkRecapSummaryInput) {
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    const config = yield* ServerConfig.ServerConfig;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const modelSelection = settings.textGenerationModelSelection;
    const { summary } = yield* textGeneration.generateWorkRecap({
      cwd: config.cwd,
      mode: input.mode,
      facts: input.facts,
      modelSelection,
    });
    return { summary, model: modelSelection.model };
  },
  Effect.mapError(
    (error) =>
      new WorkRecapSummaryError({
        message: "detail" in error ? error.detail : "The summary could not be written.",
      }),
  ),
);
