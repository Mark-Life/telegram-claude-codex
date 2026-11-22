import { heardCallName } from "./call-name";

/**
 * Why the bot would answer in a group. `call_name` is a candidate only: the
 * name was spoken, but a judge still decides whether the bot was addressed.
 */
export type Trigger = "call_name" | "mention" | "none" | "reply";

/** What a group message carries that could make the bot answer. */
export interface TriggerInput {
  botId: number;
  botUsername: string | undefined;
  /** Every name the bot answers to; see `loadHeardNames`. */
  callNames: readonly string[];
  replyToUserId: number | undefined;
  text: string;
}

/**
 * The trigger a group message carries. A mention or a reply to the bot is an
 * unambiguous address; the call name is a maybe. Anything else is chatter the
 * bot only listens to.
 */
export const detectTrigger = (input: TriggerInput): Trigger => {
  const username = input.botUsername;
  if (
    username !== undefined &&
    username.length > 0 &&
    input.text.toLowerCase().includes(`@${username.toLowerCase()}`)
  ) {
    return "mention";
  }
  if (input.replyToUserId === input.botId) {
    return "reply";
  }
  return heardCallName(input.text, input.callNames) === undefined
    ? "none"
    : "call_name";
};
