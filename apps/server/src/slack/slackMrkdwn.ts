/**
 * Converts Slack mrkdwn into the GitHub-flavored markdown clients already
 * render, resolving mentions and standard emoji on the server so every client
 * shows the same text without knowing Slack's syntax.
 */

export interface SlackMrkdwnLookups {
  readonly userName: (id: string) => string | undefined;
  readonly channelName: (id: string) => string | undefined;
}

/** Common standard emoji by Slack short name. Unknown names stay as `:name:`. */
const STANDARD_EMOJI: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  heart: "❤️",
  orange_heart: "🧡",
  yellow_heart: "💛",
  green_heart: "💚",
  blue_heart: "💙",
  purple_heart: "💜",
  black_heart: "🖤",
  broken_heart: "💔",
  joy: "😂",
  rofl: "🤣",
  smile: "😄",
  smiley: "😃",
  grinning: "😀",
  grin: "😁",
  laughing: "😆",
  sweat_smile: "😅",
  wink: "😉",
  blush: "😊",
  innocent: "😇",
  slightly_smiling_face: "🙂",
  upside_down_face: "🙃",
  relieved: "😌",
  heart_eyes: "😍",
  smiling_face_with_3_hearts: "🥰",
  kissing_heart: "😘",
  yum: "😋",
  stuck_out_tongue: "😛",
  stuck_out_tongue_winking_eye: "😜",
  zany_face: "🤪",
  sunglasses: "😎",
  nerd_face: "🤓",
  face_with_monocle: "🧐",
  "star-struck": "🤩",
  partying_face: "🥳",
  smirk: "😏",
  thinking_face: "🤔",
  shushing_face: "🤫",
  hugging_face: "🤗",
  face_with_rolling_eyes: "🙄",
  grimacing: "😬",
  neutral_face: "😐",
  expressionless: "😑",
  no_mouth: "😶",
  zipper_mouth_face: "🤐",
  melting_face: "🫠",
  saluting_face: "🫡",
  exploding_head: "🤯",
  flushed: "😳",
  pleading_face: "🥺",
  confused: "😕",
  worried: "😟",
  slightly_frowning_face: "🙁",
  disappointed: "😞",
  pensive: "😔",
  sweat: "😓",
  cold_sweat: "😰",
  cry: "😢",
  sob: "😭",
  scream: "😱",
  angry: "😠",
  rage: "😡",
  skull: "💀",
  ghost: "👻",
  poop: "💩",
  hankey: "💩",
  robot_face: "🤖",
  alien: "👽",
  see_no_evil: "🙈",
  hear_no_evil: "🙉",
  speak_no_evil: "🙊",
  eyes: "👀",
  brain: "🧠",
  wave: "👋",
  raised_hand: "✋",
  raised_hands: "🙌",
  clap: "👏",
  pray: "🙏",
  muscle: "💪",
  ok_hand: "👌",
  v: "✌️",
  crossed_fingers: "🤞",
  handshake: "🤝",
  point_up: "☝️",
  point_right: "👉",
  point_left: "👈",
  point_down: "👇",
  raising_hand: "🙋",
  shrug: "🤷",
  "man-shrugging": "🤷‍♂️",
  "woman-shrugging": "🤷‍♀️",
  facepalm: "🤦",
  "man-facepalming": "🤦‍♂️",
  "woman-facepalming": "🤦‍♀️",
  fire: "🔥",
  tada: "🎉",
  confetti_ball: "🎊",
  sparkles: "✨",
  star: "⭐",
  star2: "🌟",
  zap: "⚡",
  boom: "💥",
  rocket: "🚀",
  "100": "💯",
  trophy: "🏆",
  medal: "🏅",
  gift: "🎁",
  bulb: "💡",
  memo: "📝",
  pushpin: "📌",
  round_pushpin: "📍",
  paperclip: "📎",
  link: "🔗",
  lock: "🔒",
  unlock: "🔓",
  key: "🔑",
  bug: "🐛",
  wrench: "🔧",
  hammer: "🔨",
  hammer_and_wrench: "🛠️",
  gear: "⚙️",
  construction: "🚧",
  package: "📦",
  inbox_tray: "📥",
  outbox_tray: "📤",
  email: "📧",
  envelope: "✉️",
  computer: "💻",
  iphone: "📱",
  speech_balloon: "💬",
  thought_balloon: "💭",
  bell: "🔔",
  mega: "📣",
  loudspeaker: "📢",
  mag: "🔍",
  bookmark: "🔖",
  books: "📚",
  book: "📖",
  pencil2: "✏️",
  calendar: "📆",
  date: "📅",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  stopwatch: "⏱️",
  alarm_clock: "⏰",
  chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉",
  bar_chart: "📊",
  moneybag: "💰",
  money_with_wings: "💸",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  ballot_box_with_check: "☑️",
  x: "❌",
  heavy_multiplication_x: "✖️",
  heavy_plus_sign: "➕",
  heavy_minus_sign: "➖",
  warning: "⚠️",
  no_entry: "⛔",
  no_entry_sign: "🚫",
  octagonal_sign: "🛑",
  rotating_light: "🚨",
  question: "❓",
  grey_question: "❔",
  exclamation: "❗",
  bangbang: "‼️",
  red_circle: "🔴",
  large_orange_circle: "🟠",
  large_yellow_circle: "🟡",
  large_green_circle: "🟢",
  large_blue_circle: "🔵",
  large_purple_circle: "🟣",
  white_circle: "⚪",
  black_circle: "⚫",
  arrow_up: "⬆️",
  arrow_down: "⬇️",
  arrow_right: "➡️",
  arrow_left: "⬅️",
  arrows_counterclockwise: "🔄",
  repeat: "🔁",
  recycle: "♻️",
  checkered_flag: "🏁",
  triangular_flag_on_post: "🚩",
  new: "🆕",
  ok: "🆗",
  cool: "🆒",
  up: "🆙",
  free: "🆓",
  rainbow: "🌈",
  sunny: "☀️",
  cloud: "☁️",
  umbrella: "☔",
  snowflake: "❄️",
  coffee: "☕",
  beer: "🍺",
  beers: "🍻",
  pizza: "🍕",
  cake: "🍰",
  birthday: "🎂",
  unicorn_face: "🦄",
  dog: "🐶",
  cat: "🐱",
  monkey: "🐒",
};

const SKIN_TONES: Record<string, string> = {
  "skin-tone-2": "\u{1F3FB}",
  "skin-tone-3": "\u{1F3FC}",
  "skin-tone-4": "\u{1F3FD}",
  "skin-tone-5": "\u{1F3FE}",
  "skin-tone-6": "\u{1F3FF}",
};

/** Resolves `name` or `name::skin-tone-N` to a standard emoji character. */
export function standardEmoji(name: string): string | undefined {
  const [base = name, tone] = name.split("::");
  const emoji = STANDARD_EMOJI[base];
  if (emoji === undefined) return undefined;
  const modifier = tone === undefined ? undefined : SKIN_TONES[tone];
  // A modifier follows the base character, before any variation selector.
  return modifier === undefined ? emoji : emoji.replace(/\uFE0F$/, "") + modifier;
}

function decodeEntities(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function escapeLinkLabel(label: string): string {
  return label.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** `<...>` entities: mentions, channels, broadcasts, dates, and links. */
function convertEntity(body: string, lookups: SlackMrkdwnLookups): string {
  const [target = "", label] = body.split("|", 2);
  switch (target[0]) {
    case "@": {
      const name = lookups.userName(target.slice(1)) ?? label ?? target.slice(1);
      return `**@${name}**`;
    }
    case "#": {
      const name = label || lookups.channelName(target.slice(1)) || target.slice(1);
      return `**#${name}**`;
    }
    case "!": {
      if (target.startsWith("!subteam^")) return `**${label ?? "@group"}**`;
      if (target.startsWith("!date^")) return label ?? "";
      return `**@${target.slice(1)}**`;
    }
    default: {
      const url = decodeEntities(target);
      if (!/^(https?|mailto):/i.test(url)) return decodeEntities(body);
      return label ? `[${escapeLinkLabel(decodeEntities(label))}](${url})` : `<${url}>`;
    }
  }
}

function convertInline(text: string, lookups: SlackMrkdwnLookups): string {
  // Entities first, so formatting marks inside URLs are never touched.
  const parts = text.split(/(<[^<>\n]+>)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return convertEntity(part.slice(1, -1), lookups);
      return decodeEntities(part)
        .replace(/(^|[\s(~_])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?:;~_])/g, "$1**$2**")
        .replace(/(^|[\s(*_])~(?=\S)([^~\n]*?\S)~(?=$|[\s).,!?:;*_])/g, "$1~~$2~~")
        .replace(/:([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):/g, (match, name: string) => {
          return standardEmoji(name) ?? match;
        })
        .replace(/^(\s*)(#{1,6}\s)/gm, "$1\\$2");
    })
    .join("");
}

/** Slack mrkdwn to markdown. Code spans and blocks pass through untouched. */
export function slackMrkdwnToMarkdown(text: string, lookups: SlackMrkdwnLookups): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return segments
    .map((segment, index) => {
      if (index % 2 === 0) return convertInline(segment, lookups);
      if (segment.startsWith("```")) {
        // Slack allows a fence on the same line as its code; markdown does not.
        const code = decodeEntities(segment.slice(3, -3)).replace(/^\n/, "").replace(/\n$/, "");
        return `\n\`\`\`\n${code}\n\`\`\`\n`;
      }
      return decodeEntities(segment);
    })
    .join("");
}

/** User ids mentioned in `text`, so their names can be fetched before converting. */
export function slackMentionedUserIds(text: string): string[] {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((match) => match[1] as string);
}
