import { useEffect, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { Notice, Page, UsersIcon } from "../_social/ui";
import { useSignedIn } from "../_social/serverApi";
import { describeDrift } from "./follow";
import { inviteLink, useListenAlong } from "./store";
import "./style.css";

export const LISTEN_ITEM_ID = "listen-along";

function NowPlaying({ track, label }: { track: Track | null; label: string }) {
  if (!track) return <p className="muted small">{label}</p>;
  return (
    <div className="la-now">
      <span className="la-cover">
        <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} />
      </span>
      <div className="sx-grow">
        <div className="sx-title">{track.title}</div>
        <div className="sx-sub">{primaryArtist(track)}</div>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          window.prompt("Copy this:", text);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function ListenerList({ names }: { names: string[] }) {
  if (names.length === 0) return <p className="muted small">Nobody has joined yet.</p>;
  return (
    <ul className="sx-chips" aria-label="Listeners">
      {names.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function HostView() {
  const { room, listeners, link, end, notice } = useListenAlong();
  const current = usePlayer((s) => s.current);
  if (!room) return null;
  const link_ = inviteLink(room.id);
  return (
    <div className="sx-stack">
      <section className="sx-card">
        <div className="eyebrow">You are hosting</div>
        <h2 style={{ fontSize: "1.2rem" }}>{room.name}</h2>
        <div className="la-code" aria-label={`Room code ${room.id.split("").join(" ")}`}>
          {room.id}
        </div>
        <p className="muted small">Friends on this server enter the code in Listen along, or open the link in the web player.</p>
        <div className="sx-row">
          <CopyButton text={room.id} label="Copy code" />
          <CopyButton text={link_} label="Copy invite link" />
        </div>
        <p className="muted small la-link selectable">{link_}</p>
      </section>
      <section className="sx-card">
        <h2>Playing for the room</h2>
        <NowPlaying track={current} label="Play something and everyone follows along." />
        <p className="muted small" style={{ marginTop: 8 }}>
          Guests hear it only if they can play it from their own sources (your server's songs work for everyone on this server).
        </p>
      </section>
      <section className="sx-card">
        <h2>
          Listeners ({listeners.length}) <span className={`la-dot ${link}`} title={link} />
        </h2>
        <ListenerList names={listeners} />
      </section>
      {notice && <Notice>{notice}</Notice>}
      <div>
        <button className="btn danger" onClick={() => void end()}>
          End room
        </button>
      </div>
    </div>
  );
}

function GuestView() {
  const { room, hostTrack, host, drift, unplayable, listeners, link, leave, resync, notice } = useListenAlong();
  const local = usePlayer((s) => s.current);
  const playing = usePlayer((s) => s.isPlaying);
  if (!room) return null;
  const inStep = !!host?.trackId && local?.id === host.trackId;
  let status: string;
  if (link === "reconnecting") status = "Reconnecting...";
  else if (link === "lost") status = "Connection lost.";
  else if (link === "connecting") status = "Connecting...";
  else if (!host?.trackId) status = "Waiting for the host to play something.";
  else if (unplayable) status = "Can't play this song here.";
  else if (!inStep) status = "You're playing something else.";
  else if (!host.playing) status = "The host paused.";
  else if (!playing) status = "You paused. Tap Resync to catch up.";
  else status = drift === null ? "Catching up..." : describeDrift(drift);

  return (
    <div className="sx-stack">
      <section className="sx-card">
        <div className="eyebrow">Listening along</div>
        <h2 style={{ fontSize: "1.2rem" }}>{room.name}</h2>
        <p className="muted small">Hosted by {room.hostName}</p>
        <NowPlaying track={hostTrack} label="The host isn't playing anything right now." />
        <p className={`la-status${unplayable ? " warn" : ""}`} role="status">
          {status}
        </p>
        {unplayable && (
          <Notice kind="warn">
            "{unplayable.title}" can't be played from your sources (it may be on a service you haven't connected). You'll rejoin automatically on the host's next song.
          </Notice>
        )}
        <div className="sx-row">
          <button className="btn" onClick={resync}>
            Resync
          </button>
          <button className="btn" onClick={leave}>
            Leave room
          </button>
        </div>
      </section>
      <section className="sx-card">
        <h2>
          Also here ({listeners.length}) <span className={`la-dot ${link}`} title={link} />
        </h2>
        <ListenerList names={listeners} />
      </section>
      {notice && <Notice>{notice}</Notice>}
    </div>
  );
}

function Lobby() {
  const { start, join, busy, error, notice, invite } = useListenAlong();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    if (invite) setCode(invite);
  }, [invite]);
  return (
    <div className="sx-grid">
      <section className="sx-card">
        <h2>Host a room</h2>
        <p className="muted small">Pick a name, then play music as usual. People in your room hear it with you, in step with your playback.</p>
        <label className="field-label" htmlFor="la-name">
          Room name (optional)
        </label>
        <input id="la-name" className="text-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Friday evening" />
        <div style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy} onClick={() => void start(name)}>
            Start room
          </button>
        </div>
      </section>
      <section className="sx-card">
        <h2>Join a room</h2>
        {invite && <Notice>You were invited to a room. Check the code and tap Join.</Notice>}
        <label className="field-label" htmlFor="la-code">
          Room code
        </label>
        <input
          id="la-code"
          className="text-input la-code-input"
          value={code}
          maxLength={12}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && void join(code)}
          placeholder="ABC123"
        />
        <div style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy || !code.trim()} onClick={() => void join(code)}>
            Join
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          You follow the host's song and position, and can leave any time. Songs you can't play from your own sources are skipped with a message.
        </p>
      </section>
      {(error || notice) && (
        <div style={{ gridColumn: "1 / -1" }}>
          <Notice kind={error ? "error" : "info"}>{error ?? notice}</Notice>
        </div>
      )}
    </div>
  );
}

export function ListenAlongPage() {
  const signedIn = useSignedIn();
  const role = useListenAlong((s) => s.role);
  const resumeIfHosting = useListenAlong((s) => s.resumeIfHosting);
  useEffect(() => {
    if (signedIn) void resumeIfHosting();
  }, [signedIn, resumeIfHosting]);

  return (
    <Page className="la-page" title="Listen along" subtitle="Listen to the same song at the same time as someone else on your server.">
      {!signedIn ? (
        <div className="sx-card">
          <UsersIcon />
          <p>Sign in to your Cadence server to host or join a room.</p>
          <p className="muted small">Open Settings, then Server. Rooms are shared between accounts on the same server only.</p>
        </div>
      ) : role === "host" ? (
        <HostView />
      ) : role === "guest" ? (
        <GuestView />
      ) : (
        <Lobby />
      )}
    </Page>
  );
}