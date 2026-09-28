import { SlackImageUrl, type SlackImage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const SlackImageFile = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  mimetype: Schema.String,
  url_private: SlackImageUrl,
});
const decodeImageFile = Schema.decodeUnknownOption(SlackImageFile);

/** Keep image metadata in the feed; bytes load only when a conversation is opened. */
export function slackImages(files: ReadonlyArray<unknown> = []): SlackImage[] {
  return files.flatMap((file) => {
    const decoded = decodeImageFile(file);
    if (Option.isNone(decoded) || !decoded.value.mimetype.startsWith("image/")) return [];
    const image = decoded.value;
    return [
      { id: image.id, name: image.title || image.name || "Slack image", url: image.url_private },
    ];
  });
}
