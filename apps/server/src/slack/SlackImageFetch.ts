import { SlackImageUrl } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const isSlackImageUrl = Schema.is(SlackImageUrl);
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

/** Stream private images without exposing the token or carrying it to a redirect off Slack. */
export const slackImageResponse = Effect.fn("SlackImageFetch.response")(function* (
  url: string,
  token: string,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  let target = url;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!isSlackImageUrl(target)) return HttpServerResponse.empty({ status: 400, headers });
    const response = yield* client
      .execute(HttpClientRequest.get(target).pipe(HttpClientRequest.bearerToken(token)))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.location ? URL.parse(response.headers.location, target) : null;
      if (!next) return HttpServerResponse.empty({ status: 502, headers });
      target = next.href;
      continue;
    }
    if (response.status !== 200) {
      return HttpServerResponse.empty({
        status: response.status >= 500 ? 502 : response.status,
        headers,
      });
    }
    const contentType =
      response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!/^image\/[\w.+-]+$/.test(contentType))
      return HttpServerResponse.empty({ status: 415, headers });
    return HttpServerResponse.stream(response.stream, { headers, contentType });
  }
  return HttpServerResponse.empty({ status: 502, headers });
});
