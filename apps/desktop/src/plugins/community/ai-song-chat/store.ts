import { create } from "zustand";
import { askText, requireProvider } from "@/features/dj/ask";
import type { LlmMessage } from "../../../../electron/llm";
import type { Track } from "@/shared/types";
import { boundAnswer, buildChatMessages, cleanQuestion, trackLabel, type ChatMessage } from "./chat";

export interface ChatDeps {
  provider: () => Promise<{ ref: string }>;
  ask: (ref: string, opts: { messages: LlmMessage[]; signal: AbortSignal; onDelta: (text: string) => void }) => Promise<string>;
}

export interface ChatState {
  messages: ChatMessage[];
  /** A song picked from a track menu; otherwise the chat follows what is playing. */
  pinned: Track | null;
  status: "idle" | "answering";
  error: unknown;
  /** The question that failed, so "Try again" can resend it. */
  failed: { question: string; track: Track } | null;
  pin: (track: Track | null) => void;
  send: (track: Track, question: string) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => void;
  clear: () => void;
}

let counter = 0;
const nextId = () => `m${++counter}`;

export function createChatStore(deps: ChatDeps) {
  let abort: AbortController | null = null;

  return create<ChatState>((set, get) => ({
    messages: [],
    pinned: null,
    status: "idle",
    error: null,
    failed: null,

    pin: (pinned) => set({ pinned }),

    async send(track, rawQuestion) {
      const question = cleanQuestion(rawQuestion);
      if (!question || get().status === "answering") return;
      const history = get().messages;
      const user: ChatMessage = { id: nextId(), role: "user", content: question, about: trackLabel(track) };
      const reply: ChatMessage = { id: nextId(), role: "assistant", content: "" };
      set({ messages: [...history, user, reply], status: "answering", error: null, failed: null });
      const controller = new AbortController();
      abort = controller;
      const patchReply = (content: string) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? { ...m, content } : m)) }));
      try {
        const { ref } = await deps.provider();
        let text = "";
        const full = await deps.ask(ref, {
          messages: buildChatMessages(track, history, question),
          signal: controller.signal,
          onDelta: (piece) => {
            text += piece;
            patchReply(boundAnswer(text));
          },
        });
        patchReply(boundAnswer(full.trim()));
      } catch (e) {
        const stopped = controller.signal.aborted;
        const partial = get().messages.find((m) => m.id === reply.id)?.content ?? "";
        if (stopped && partial) {
          // Stopped part-way: keep what arrived.
        } else {
          // Nothing usable arrived: drop the empty answer and the question's bubble stays so it can be retried.
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== reply.id),
            error: stopped ? null : e,
            failed: stopped ? null : { question, track },
          }));
        }
      } finally {
        if (abort === controller) abort = null;
        set({ status: "idle" });
      }
    },

    async retry() {
      const failed = get().failed;
      if (!failed) return;
      // Remove the question that failed; send() adds it again.
      set((s) => {
        const last = s.messages[s.messages.length - 1];
        return { messages: last?.role === "user" ? s.messages.slice(0, -1) : s.messages };
      });
      await get().send(failed.track, failed.question);
    },

    stop() {
      abort?.abort();
    },

    clear() {
      abort?.abort();
      set({ messages: [], error: null, failed: null, status: "idle" });
    },
  }));
}

export const useSongChat = createChatStore({
  provider: requireProvider,
  ask: (ref, opts) => askText(ref, { messages: opts.messages, signal: opts.signal, onDelta: opts.onDelta }),
});
