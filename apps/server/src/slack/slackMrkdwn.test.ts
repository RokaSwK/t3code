import { describe, expect, it } from "vite-plus/test";

import { slackMentionedUserIds, slackMrkdwnToMarkdown, standardEmoji } from "./slackMrkdwn.ts";

const lookups = {
  userName: (id: string) => (id === "U1" ? "Ada" : undefined),
  channelName: (id: string) => (id === "C1" ? "general" : undefined),
};

describe("slackMrkdwnToMarkdown", () => {
  it("resolves mentions, channels, broadcasts, and links", () => {
    expect(
      slackMrkdwnToMarkdown(
        "<@U1> see <#C1> and <#C2|random>, <!here> <https://x.dev/a_b*c|the *doc*> <https://y.dev>",
        lookups,
      ),
    ).toBe(
      "**@Ada** see **#general** and **#random**, **@here** [the *doc*](https://x.dev/a_b*c) <https://y.dev>",
    );
  });

  it("converts bold and strike without touching code", () => {
    expect(slackMrkdwnToMarkdown("*ship* it ~now~ `a *b* c`", lookups)).toBe(
      "**ship** it ~~now~~ `a *b* c`",
    );
    expect(slackMrkdwnToMarkdown("look ```const x = *y*;``` done", lookups)).toBe(
      "look \n```\nconst x = *y*;\n```\n done",
    );
  });

  it("decodes entities, keeps quotes, and escapes headings", () => {
    expect(slackMrkdwnToMarkdown("&gt; quoted &amp; fine\n# not a heading", lookups)).toBe(
      "> quoted & fine\n\\# not a heading",
    );
  });

  it("replaces known emoji and leaves custom ones", () => {
    expect(slackMrkdwnToMarkdown("done :white_check_mark: :partyblob:", lookups)).toBe(
      "done ✅ :partyblob:",
    );
  });
});

describe("standardEmoji", () => {
  it("applies skin tones", () => {
    expect(standardEmoji("+1::skin-tone-3")).toBe("👍🏼");
    expect(standardEmoji("v::skin-tone-2")).toBe("✌🏻");
    expect(standardEmoji("partyblob")).toBeUndefined();
  });
});

describe("slackMentionedUserIds", () => {
  it("finds user mentions", () => {
    expect(slackMentionedUserIds("hi <@U1> and <@W22|bo>")).toEqual(["U1", "W22"]);
  });
});
