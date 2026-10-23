import { useEffect, useRef, useState } from "react";
import { AiError, AiGate } from "@/features/dj/AiUi";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { suggestions, MAX_QUESTION } from "./chat";
import { useSongChat } from "./store";
import "@/features/dj/ai.css";
import "./style.css";

export function ChatPage() {
  const chat = useSongChat();
  const playing = usePlayer((s) => s.current);
  const track = chat.pinned ?? playing;
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const answering = chat.status === "answering";

  // Keep the newest words in view while an answer streams in.
  const last = chat.messages[chat.messages.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [chat.messages.length, last?.content]);

  function submit(text: string) {
    if (!track || !text.trim()) return;
    setDraft("");
    void chat.send(track, text);
  }

  return (
    <div className="view ai-chat">
      <header className="view-header">
        <h1>Ask about this song</h1>
        <p className="muted">
          Questions go to your AI provider together with the title, artist and album. Answers can be wrong, so double-check facts that matter.
        </p>
      </header>

      <AiGate>
        {track ? (
          <div className="chat-track">
            <div className="chat-art">
              <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} />
            </div>
            <div className="chat-track-text">
              <div className="strong">{track.title}</div>
              <div className="muted small">
                {primaryArtist(track)}
                {track.album ? ` · ${track.album}` : ""}
              </div>
            </div>
            {chat.pinned && (
              <button className="btn" onClick={() => chat.pin(null)}>
                Follow what is playing
              </button>
            )}
          </div>
        ) : (
          <div className="ai-empty" role="status">
            <strong>Nothing is playing</strong>
            <p className="muted">Play a song, or choose Ask AI about this song from a track menu, then ask away.</p>
          </div>
        )}

        <div className="chat-log" role="log" aria-live="polite" aria-label="Conversation">
          {chat.messages.length === 0 && track && (
            <div className="ai-chips" aria-label="Suggested questions">
              {suggestions(track).map((q) => (
                <button key={q} className="ai-chip" disabled={answering} onClick={() => submit(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
          {chat.messages.map((m, i) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              {m.role === "user" && m.about && <div className="chat-about">{m.about}</div>}
              <div className={`chat-bubble${answering && m.content && m.role === "assistant" && i === chat.messages.length - 1 ? " streaming" : ""}`}>
                {m.content || (answering && m.role === "assistant" ? <span className="chat-dots">Thinking…</span> : "")}
              </div>
            </div>
          ))}
          <AiError error={chat.error} />
          {chat.failed && !answering && (
            <div className="ai-actions">
              <button className="btn" onClick={() => void chat.retry()}>
                Try again
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <input
            className="text-input"
            aria-label="Your question"
            value={draft}
            maxLength={MAX_QUESTION}
            disabled={!track}
            placeholder={track ? "Ask anything about this song…" : "Play a song first"}
            onChange={(e) => setDraft(e.target.value)}
          />
          {answering ? (
            <button type="button" className="btn" onClick={chat.stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!track || !draft.trim()}>
              Send
            </button>
          )}
          {chat.messages.length > 0 && !answering && (
            <button type="button" className="btn ghost" onClick={chat.clear}>
              New chat
            </button>
          )}
        </form>
      </AiGate>
    </div>
  );
}
