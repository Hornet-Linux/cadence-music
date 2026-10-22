import { currentOption, localConfig, providerStatus, useProviders, type ProviderOption } from "@/features/dj/providers";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { extractJson } from "../../../../electron/llm";
import {
  buildTranslateMessages,
  cleanTranslations,
  TRANSLATE_SCHEMA,
} from "../../../../../server/src/community/lyrics-translate/prompt";
import { BadAnswer, type SendBatch } from "./translate";

const SETUP_HINT = "Set one up in Settings, AI DJ (a server provider, or one on this device such as Ollama).";

export class NoProvider extends Error {}

/** The AI provider the listener chose for the AI DJ, refreshed from the server first. */
export async function chooseProvider(): Promise<ProviderOption> {
  await useProviders.getState().refreshRemote();
  const option = currentOption();
  if (!option) throw new NoProvider(`No AI provider is set up. ${SETUP_HINT}`);
  return option;
}

/** Make sure the provider answers, with a message the listener can act on if not. */
export async function checkProvider(option: ProviderOption): Promise<void> {
  if (option.scope === "device") {
    throw new NoProvider(
      `Translation cannot use the AI on another of your computers (${option.where}). Pick a server provider or one on this device in Settings, AI DJ.`,
    );
  }
  let status;
  try {
    status = await providerStatus(option.ref);
  } catch (err) {
    throw new NoProvider(`The AI provider ${option.name} could not be reached${err instanceof Error ? `: ${err.message}` : ""}. ${SETUP_HINT}`);
  }
  if (!status.available) {
    throw new NoProvider(`The AI provider ${option.name} is not available${status.error ? ` (${status.error})` : ""}. ${SETUP_HINT}`);
  }
}

/** A sender that translates through the chosen provider. */
export function senderFor(option: ProviderOption, target: string): SendBatch {
  return async (lines, signal) => {
    const messages = buildTranslateMessages(lines, target);
    if (option.scope === "server") {
      try {
        const res = await useServer.getState().api<{ translations: string[] }>("api/lyrics/translate", {
          method: "POST",
          body: JSON.stringify({ provider: option.ref, lines, target }),
          signal,
        });
        if (!Array.isArray(res?.translations)) throw new BadAnswer("bad reply");
        return res.translations;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          throw new NoProvider(
            "The server does not have the Lyrics translation plugin turned on. Ask the server owner to enable it in Settings, Plugins, or pick a provider on this device in Settings, AI DJ.",
          );
        }
        if ((err as { code?: string }).code === "bad_reply") throw new BadAnswer("bad reply");
        throw err;
      }
    }
    if (option.scope === "native") {
      const bridge = window.CadenceNative;
      if (!bridge) throw new NoProvider("This device has no on-device AI.");
      const raw = await bridge.aiChatJson(JSON.stringify({ messages, schema: TRANSLATE_SCHEMA, temperature: 0.2 }));
      const clean = cleanTranslations(typeof raw === "string" ? extractJson(raw) : raw, lines.length);
      if (!clean) throw new BadAnswer("bad reply");
      return clean;
    }
    const llm = window.host?.llm;
    if (!llm) throw new NoProvider("AI translation is not available in this build.");
    const local = useProviders.getState().local.find((p) => `local:${p.id}` === option.ref);
    if (!local) throw new NoProvider("That AI provider was removed. Pick another in Settings, AI DJ.");
    const reply = await llm.chatJson(await localConfig(local), {
      messages,
      schema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.2,
    });
    const clean = cleanTranslations(reply, lines.length);
    if (!clean) throw new BadAnswer("bad reply");
    return clean;
  };
}
