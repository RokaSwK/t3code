import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { parseSlackThreadUrl, ThreadSlackLinks } from "./slack.ts";
const decode = Schema.decodeUnknownSync(ThreadSlackLinks);

describe("Slack thread links", () => {
  it("canonicalizes a copied reply to its parent thread", () => {
    expect(
      parseSlackThreadUrl(
        "https://acme.slack.com/archives/C123/p1790000001123456?thread_ts=1790000000.000001&cid=C123",
      ),
    ).toEqual({
      channelId: "C123",
      ts: "1790000000.000001",
      url: "https://acme.slack.com/archives/C123/p1790000000000001",
    });
  });
  it.each([
    "https://slack.com.evil.test/archives/C1/p1790000000000000",
    "http://acme.slack.com/archives/C1/p1790000000000000",
    "https://acme.slack.com/archives/C1/p123",
    "https://acme.slack.com/archives/C1/p1790000000000000?thread_ts=oops",
    "https://user@acme.slack.com/archives/C1/p1790000000000000",
  ])("rejects invalid link %s", (url) => {
    expect(parseSlackThreadUrl(url)).toBeNull();
    expect(() => decode([url])).toThrow();
  });
  it("limits the number of persisted links", () => {
    expect(() =>
      decode(Array(21).fill("https://acme.slack.com/archives/C1/p1790000000000000")),
    ).toThrow();
  });
});
