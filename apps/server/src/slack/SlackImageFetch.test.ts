import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";

import { slackImages } from "./slackImages.ts";
import { slackImageResponse } from "./SlackImageFetch.ts";

const imageUrl = "https://files.slack.com/files-pri/T1-F1/screenshot.png";

describe("Slack images", () => {
  it("keeps image metadata and leaves unsupported or inaccessible files as file counts", () => {
    expect(
      slackImages([
        { id: "F1", title: "Screenshot", mimetype: "image/png", url_private: imageUrl },
        { id: "F2", mimetype: "application/pdf", url_private: imageUrl },
        { id: "F3", mimetype: "image/png", url_private: "https://example.com/private.png" },
        { id: "F4", file_access: "check_file_info" },
        null,
      ]),
    ).toEqual([{ id: "F1", name: "Screenshot", url: imageUrl }]);
  });

  it.effect("streams image bytes with the Slack credential and refuses non-image responses", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const image = yield* slackImageResponse(imageUrl, "test-token");
      expect(image.status).toBe(200);
      expect(image.headers["content-type"]).toBe("image/png");
      const web = HttpServerResponse.toWeb(image);
      expect(yield* Effect.promise(() => web.text())).toBe("image-bytes");
      const html = yield* slackImageResponse(imageUrl, "test-token");
      expect(html.status).toBe(415);
      expect(calls).toEqual(["Bearer test-token", "Bearer test-token"]);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          calls.push(request.headers.authorization ?? "");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("image-bytes", {
                headers: { "content-type": calls.length === 1 ? "image/png" : "text/html" },
              }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("does not send credentials to foreign URLs or redirects", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      expect(
        (yield* slackImageResponse("https://example.com/image.png", "test-token")).status,
      ).toBe(400);
      expect((yield* slackImageResponse(imageUrl, "test-token")).status).toBe(400);
      expect(calls).toEqual([imageUrl]);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
            expect(Option.getOrThrow(requestInit).redirect).toBe("manual");
            calls.push(request.url);
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 302,
                headers: { location: "https://example.com/image.png" },
              }),
            );
          }),
        ),
      ),
      Effect.scoped,
    );
  });
});
