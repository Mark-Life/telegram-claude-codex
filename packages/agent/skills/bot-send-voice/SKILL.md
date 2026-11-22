---
name: bot-send-voice
description: Use when the user asks for a voice message, a voice note or an audio answer ("send me a voice message", "explain it by voice", "озвучь", "ответь голосом"). Covers writing a script for the ear, the helper that speaks it with ElevenLabs and sends it to the chat as a Telegram voice message, and what to do when voice is not set up.
---

# Sending a voice message

Only when the user asks for a voice message or an audio answer. Do the work first (research, reading, thinking) exactly as for a text answer; the voice message is how you deliver the result.

## 1. Write the script for the ear

A listener cannot scan, scroll back or see formatting. Write the way a person talks when they explain something to a friend, not the way you write a chat reply.

- Plain text only. No markdown, headings, bullets, tables, emoji, links or code. Anything the voice would read aloud as symbols goes.
- Short sentences, one idea each. Lead with the answer, then the why, then the detail. Close with a one-sentence recap when the message is longer than a minute.
- Spoken structure instead of visual structure: "There are three reasons. First, … Second, … And third, …". Use paragraph breaks for pauses between parts.
- Say numbers, dates, units and symbols as words: "about two and a half thousand", "the fourteenth of March", "forty percent", "five kilometres". Round when precision does not matter.
- Expand abbreviations unless people say them as they are ("NASA", "API"). Leave a URL, a file path or code out and offer to send it as text.
- Use the language the user wrote in, plain and neutral in tone. Write names and foreign terms the way they are pronounced if they might be misread.
- Length: what the user asked for; otherwise one to three minutes, which is about 150 words a minute in English, a bit fewer in Russian. The helper refuses more than fifteen thousand characters: send a long answer as text and offer a short spoken summary.
- Delivery cues: the Eleven v4 models follow audio tags in square brackets, such as `[warmly]` or `[laughs]`, and ellipses for a hesitation. Use them rarely, only where the tone truly changes, never in a factual explanation by default. You do not know which model the owner picked; the helper takes the tags out for a model that would read them aloud.

## 2. Send it

The helper's path is this file's path with `skills/bot-send-voice/SKILL.md` replaced by `scripts/send-voice-to-user.ts`. Save the script to a new file in `$TMPDIR` (or the system temp dir), then call the helper by its absolute path:

```
bun <absolute path to send-voice-to-user.ts> --text-file <absolute script path> --chat <id> [--thread <id>] [--caption <short text>]
```

Pass `--chat` and `--thread` exactly as your prompt's file line gives them for this turn, unchanged, so the voice message reaches the conversation that asked for it. When the prompt gives no `--thread`, leave it out. `--caption` is optional: one short line under the voice message, such as its title. The helper prints `Sent voice: … duration=<seconds>s` on success. Delete the script file afterwards.

The voice and the model are the owner's choice in `/settings` → «Голосовые ответы»; never pick them yourself.

## 3. Reply in text

After the voice message is sent, answer in text in one or two sentences: what the voice message covers, plus anything that does not work spoken (links, code, exact figures) as a short list. Do not repeat the whole script as text unless the user asks for it.

## When it fails

- `Voice messages are not set up`: tell the user that voice replies need an ElevenLabs API key (`ELEVENLABS_API_KEY` in the bot's `.env`, then a restart) and answer in text this time.
- `has no voices`: tell the user to add a voice in their ElevenLabs account (My Voices) and answer in text.
- A refused chat, an ElevenLabs or Telegram error: say so in one sentence and give the answer as text. Never send audio another way, never call the Telegram or ElevenLabs API directly.
