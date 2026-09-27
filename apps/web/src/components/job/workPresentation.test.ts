import { describe, expect, it } from "vite-plus/test";

import { slackMessageSummary } from "./workPresentation";

describe("slackMessageSummary", () => {
  it("drops Devin's session links and the automation's on-your-behalf mention", () => {
    expect(
      slackMessageSummary(
        "**@Jaime**: generate a pdf for him [Support](<https://support.tuyo.dev/c/1>) · [97990](<https://b.tuyo.com/a/9>) [[↗︎]](<https://app.devin.ai/sessions/abc?ts=1>) [[⚙︎]](<https://app.devin.ai/org/x>)",
      ),
    ).toBe("generate a pdf for him Support · 97990");
  });

  it("leads with the words around a link rather than the link", () => {
    expect(slackMessageSummary("https://acme.slack.com/archives/C0/p1 Fake news.")).toBe(
      "Fake news.",
    );
    expect(
      slackMessageSummary("[youtube.com/watch?v=NYF](https://youtube.com/watch?v=NYF) the pod"),
    ).toBe("the pod");
    expect(slackMessageSummary("<https://acme.test/only>")).toBe("Shared a link");
  });
});
