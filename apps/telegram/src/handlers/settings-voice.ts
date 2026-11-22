import { pickVoice, TTS_MODELS, ttsModelOf } from "@workspace/agent";
import { InlineKeyboard } from "grammy";

import { getSetting } from "../db/bridge";
import { t } from "../i18n";
import { personaGenderOf } from "../persona";
import type { VoiceList } from "../settings/service";
import { escapeHtml } from "../telegram/format";

/**
 * «Голосовые ответы» in `/settings`: the voice and model a voice reply is
 * spoken with (`send-voice-to-user.ts` reads the same two rows). The voices
 * are the owner's ElevenLabs account's, asked for on every draw, so a voice
 * added there shows up here without a restart. A press is `voice:<field>:<id>`.
 */

/** How many voices the screen offers; the account's own come first. */
const SHOWN_VOICES = 12;

/** What the voice screen shows, read at once. */
const readVoiceView = async (list: () => Promise<VoiceList>) => {
  const [voices, voice, model, gender] = await Promise.all([
    list(),
    getSetting("tts_voice"),
    getSetting("tts_model"),
    getSetting("persona_gender"),
  ]);
  return {
    gender: personaGenderOf(gender),
    model: ttsModelOf(model),
    stored: voice,
    voices,
  };
};

const mark = (on: boolean, label: string) => (on ? `✓ ${label}` : label);

/** The voice screen's text (HTML) and keyboard. */
export const renderVoice = async (list: () => Promise<VoiceList>) => {
  const copy = t().settings.voice;
  const view = await readVoiceView(list);
  const keyboard = new InlineKeyboard();
  const lines = [`<b>${escapeHtml(copy.label)}</b>`, escapeHtml(copy.hint)];
  if (view.voices.kind === "off") {
    lines.push(escapeHtml(copy.off));
  } else if (view.voices.kind === "failed") {
    lines.push(escapeHtml(copy.failed(view.voices.reason)));
  } else {
    const current = pickVoice({
      gender: view.gender,
      stored: view.stored,
      voices: view.voices.voices,
    });
    lines.push(
      escapeHtml(
        [
          current === undefined ? copy.empty : copy.voice(current.name),
          copy.model(copy.models[view.model]),
        ].join("\n")
      )
    );
    for (const model of TTS_MODELS) {
      keyboard
        .text(
          mark(model === view.model, copy.models[model]),
          `voice:model:${model}`
        )
        .row();
    }
    for (const voice of view.voices.voices.slice(0, SHOWN_VOICES)) {
      keyboard
        .text(
          mark(voice.id === current?.id, voice.name),
          `voice:voice:${voice.id}`
        )
        .row();
    }
  }
  keyboard.text(t().settings.defaults.back, "menu:bot");
  return { keyboard, text: lines.join("\n\n") };
};
