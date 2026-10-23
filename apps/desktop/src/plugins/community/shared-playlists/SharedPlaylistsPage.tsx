import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { useLibraryTracks } from "../_social/libraryTracks";
import { useSignedIn } from "../_social/serverApi";
import { Notice, Page, ThumbIcon, UsersIcon } from "../_social/ui";
import { canRemove, playOrder, type SharedDetail } from "./model";
import { useSharedPlaylists } from "./store";
import "./style.css";

export const SHARED_ITEM_ID = "shared-playlists";

function Copy({ text, label }: { text: string; label: string }) {
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

function AddSongs({ onAdd, busy }: { onAdd: (t: Track) => void; busy: boolean }) {
  const library = useLibraryTracks();
  const current = usePlayer((s) => s.current);
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return library.filter((t) => `${t.title} ${primaryArtist(t)} ${t.album ?? ""}`.toLowerCase().includes(needle)).slice(0, 12);
  }, [library, q]);
  return (
    <section className="sx-card">
      <h2>Add songs</h2>
      <div className="sx-row" style={{ marginBottom: 10 }}>
        <button className="btn" disabled={!current || busy} onClick={() => current && onAdd(current)}>
          Add what's playing
        </button>
        {current && <span className="muted small sp-now">{current.title}</span>}
      </div>
      <label className="field-label" htmlFor="sp-search">
        Search your library
      </label>
      <input id="sp-search" className="text-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song, artist or album" />
      {results.length > 0 && (
        <ul className="sx-list" style={{ marginTop: 8 }}>
          {results.map((t) => (
            <li key={t.id}>
              <span className="sx-thumb">
                <CoverArt src={t.artwork} seed={t.album ?? t.title} label={t.title} showInitial={false} />
              </span>
              <span className="sx-grow">
                <span className="sx-title" style={{ display: "block" }}>{t.title}</span>
                <span className="sx-sub" style={{ display: "block" }}>{primaryArtist(t)}</span>
              </span>
              <button className="btn" disabled={busy} onClick={() => onAdd(t)} aria-label={`Add ${t.title}`}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && results.length === 0 && <p className="muted small">No matches in your library.</p>}
    </section>
  );
}

function Detail({ detail, me }: { detail: SharedDetail; me: number | null }) {
  const store = useSharedPlaylists();
  const playQueue = usePlayer((s) => s.playQueue);
  const currentId = usePlayer((s) => s.current?.id);
  const [invite, setInvite] = useState("");
  const [name, setName] = useState(detail.name);
  useEffect(() => setName(detail.name), [detail.name]);

  // Pick up other people's changes while this page is open.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void store.refresh();
    }, 8000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  const tracks = playOrder(detail);
  return (
    <div className="sx-stack">
      <button className="btn ghost sp-back" onClick={store.close}>
        All shared playlists
      </button>
      <section className="sx-card">
        {detail.isOwner ? (
          <div className="sx-row">
            <input aria-label="Playlist name" className="text-input sx-grow" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            <button className="btn" disabled={store.busy || !name.trim() || name === detail.name} onClick={() => void store.rename(name)}>
              Rename
            </button>
          </div>
        ) : (
          <h2 style={{ fontSize: "1.2rem" }}>{detail.name}</h2>
        )}
        <p className="muted small" style={{ marginTop: 8 }}>
          {detail.items.length} songs, ordered by votes. Add songs and vote with the arrows; the most liked rise to the top.
        </p>
        <div className="sx-row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={tracks.length === 0} onClick={() => void playQueue(tracks, 0)}>
            Play all
          </button>
          {detail.isOwner ? (
            <button
              className="btn danger"
              onClick={() => {
                if (window.confirm(`Delete "${detail.name}" for everyone?`)) void store.remove();
              }}
            >
              Delete
            </button>
          ) : (
            <button className="btn" onClick={() => void store.leave()}>
              Leave
            </button>
          )}
        </div>
      </section>

      <section className="sx-card">
        <h2>Songs</h2>
        {detail.items.length === 0 ? (
          <p className="muted">Nothing here yet. Add a song below.</p>
        ) : (
          <ol className="sx-list sp-items">
            {detail.items.map((item, i) => (
              <li key={item.id} className={currentId === item.track.id ? "sp-current" : ""}>
                <span className="sx-rank">{i + 1}</span>
                <button className="sp-play" onClick={() => void playQueue(tracks, i)} aria-label={`Play ${item.track.title}`}>
                  <span className="sx-thumb">
                    <CoverArt src={item.track.artwork} seed={item.track.album ?? item.track.title} label={item.track.title} showInitial={false} />
                  </span>
                  <span className="sx-grow" style={{ textAlign: "left" }}>
                    <span className="sx-title" style={{ display: "block" }}>{item.track.title}</span>
                    <span className="sx-sub" style={{ display: "block" }}>
                      {primaryArtist(item.track)}
                      {item.addedBy ? ` · added by ${item.addedBy.name}` : ""}
                    </span>
                  </span>
                </button>
                <span className="sp-votes" role="group" aria-label={`Votes for ${item.track.title}`}>
                  <button className={`sx-icon-btn${item.myVote === 1 ? " on" : ""}`} aria-pressed={item.myVote === 1} aria-label="Vote up" onClick={() => void store.vote(item.id, 1)}>
                    <ThumbIcon size={20} />
                  </button>
                  <span className="sp-score" aria-label={`Score ${item.score}`}>{item.score}</span>
                  <button className={`sx-icon-btn${item.myVote === -1 ? " on" : ""}`} aria-pressed={item.myVote === -1} aria-label="Vote down" onClick={() => void store.vote(item.id, -1)}>
                    <ThumbIcon size={20} down />
                  </button>
                </span>
                {canRemove(detail, item, me) && (
                  <button className="sx-icon-btn" aria-label={`Remove ${item.track.title}`} onClick={() => void store.removeItem(item.id)}>
                    &times;
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <AddSongs busy={store.busy} onAdd={(t) => void store.addTrack(t)} />

      <section className="sx-card">
        <h2>People ({detail.members.length})</h2>
        <ul className="sx-chips sp-members">
          {detail.members.map((m) => (
            <li key={m.id}>
              {m.name}
              {m.id === detail.ownerId ? " (owner)" : ""}
              {detail.isOwner && m.id !== detail.ownerId && (
                <button className="sp-x" aria-label={`Remove ${m.name}`} onClick={() => void store.removeMember(m.id)}>
                  &times;
                </button>
              )}
            </li>
          ))}
        </ul>
        {detail.isOwner && (
          <div className="sx-stack" style={{ marginTop: 12 }}>
            <div>
              <div className="field-label">Invite code</div>
              <div className="sx-row">
                <code className="sp-code">{detail.joinCode}</code>
                {detail.joinCode && <Copy text={detail.joinCode} label="Copy" />}
                <button className="btn ghost" onClick={() => void store.newCode()}>
                  New code
                </button>
              </div>
              <p className="muted small">Anyone on this server with the code can join. Make a new code to stop the old one working.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="sp-invite">
                Or add someone by username
              </label>
              <div className="sx-row">
                <input id="sp-invite" className="text-input sx-grow" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="username" autoCapitalize="none" />
                <button
                  className="btn"
                  disabled={!invite.trim() || store.busy}
                  onClick={async () => {
                    await store.invite(invite.trim());
                    setInvite("");
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Home() {
  const store = useSharedPlaylists();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  return (
    <div className="sx-stack">
      <div className="sx-grid">
        <section className="sx-card">
          <h2>New shared playlist</h2>
          <label className="field-label" htmlFor="sp-name">
            Name
          </label>
          <input id="sp-name" className="text-input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Road trip" />
          <div style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              disabled={store.busy || !name.trim()}
              onClick={async () => {
                await store.create(name.trim());
                setName("");
              }}
            >
              Create
            </button>
          </div>
        </section>
        <section className="sx-card">
          <h2>Join with a code</h2>
          <label className="field-label" htmlFor="sp-code">
            Invite code
          </label>
          <input id="sp-code" className="text-input" value={code} maxLength={12} autoCapitalize="characters" autoComplete="off" onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD2345" />
          <div style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              disabled={store.busy || !code.trim()}
              onClick={async () => {
                await store.join(code);
                setCode("");
              }}
            >
              Join
            </button>
          </div>
        </section>
      </div>

      <section>
        <h2 className="sp-heading">Your shared playlists</h2>
        {store.list === null ? (
          <p className="muted">Loading...</p>
        ) : store.list.length === 0 ? (
          <div className="sx-card">
            <UsersIcon />
            <p>No shared playlists yet.</p>
            <p className="muted small">Create one and send the code to a friend on your server, or join theirs.</p>
          </div>
        ) : (
          <ul className="sp-tiles">
            {store.list.map((p) => (
              <li key={p.id}>
                <button className="sp-tile" onClick={() => void store.open(p.id)}>
                  <span className="sp-mosaic" aria-hidden>
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i}>
                        <CoverArt src={p.artwork[i]} seed={`${p.id}${i}`} showInitial={false} />
                      </span>
                    ))}
                  </span>
                  <span className="sx-title" style={{ display: "block" }}>{p.name}</span>
                  <span className="sx-sub" style={{ display: "block" }}>
                    {p.trackCount} songs · {p.memberCount} people{p.isOwner ? "" : ` · by ${p.ownerName}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function SharedPlaylistsPage() {
  const signedIn = useSignedIn();
  const me = useServer((s) => s.user?.id ?? null);
  const { detail, error, clearError, loadList } = useSharedPlaylists();
  useEffect(() => {
    if (signedIn) void loadList();
  }, [signedIn, loadList]);
  return (
    <Page className="sp-page" title="Shared playlists" subtitle="Build playlists together with other people on your server. Everyone adds songs and votes; the favourites rise to the top.">
      {!signedIn ? (
        <div className="sx-card">
          <UsersIcon />
          <p>Sign in to your Cadence server to use shared playlists.</p>
          <p className="muted small">Open Settings, then Server.</p>
        </div>
      ) : (
        <>
          {error && (
            <div className="sx-notice-row" onClick={clearError}>
              <Notice kind="error">{error}</Notice>
            </div>
          )}
          {detail ? <Detail detail={detail} me={me} /> : <Home />}
        </>
      )}
    </Page>
  );
}