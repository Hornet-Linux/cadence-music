import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { TrackRow } from "@/ui/media";
import { PlayIcon, PlusIcon, TrashIcon } from "@/ui/icons";
import { call, explainError, pluralize, send, useLoad } from "../_serverlib/api";
import { ErrorNotice, Gate, Page, serverTrackToTrack } from "../_serverlib/ui";
import {
  FIELDS,
  FIELD_ORDER,
  OP_LABELS,
  SORT_LABELS,
  TEMPLATES,
  changeField,
  changeOp,
  describeDefinition,
  emptyDraft,
  fromDefinition,
  incompleteRules,
  missingData,
  newRule,
  toDefinition,
  type Definition,
  type Draft,
  type DraftRule,
  type Field,
  type SavedPlaylist,
  type SortField,
} from "./model";

interface Item {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
}
interface Evaluated {
  total: number;
  items: Item[];
}
interface Meta {
  coverage: { tracks: number; genre: number; year: number; loudness: number | null; bpm: number | null; energy: number | null };
  genres: string[];
}

const toTracks = (items: Item[]) => items.map((i) => serverTrackToTrack(i));

function RuleEditor({
  rule,
  genres,
  onChange,
  onRemove,
}: {
  rule: DraftRule;
  genres: string[];
  onChange: (r: DraftRule) => void;
  onRemove: () => void;
}) {
  const info = FIELDS[rule.field];
  const ops = OP_LABELS[info.type];
  const listId = `genres-${rule.key}`;
  return (
    <div className="sp-rule card">
      <select
        className="text-input"
        aria-label="Field"
        value={rule.field}
        onChange={(e) => onChange(changeField(rule, e.target.value as Field))}
      >
        {FIELD_ORDER.map((f) => (
          <option key={f} value={f}>
            {FIELDS[f].label}
          </option>
        ))}
      </select>
      {info.type !== "bool" && (
        <select
          className="text-input"
          aria-label="Condition"
          value={rule.op}
          onChange={(e) => onChange(changeOp(rule, e.target.value))}
        >
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <div className="sp-values">
        {info.type === "text" && (
          <>
            <input
              className="text-input"
              aria-label="Value"
              placeholder={rule.field === "genre" ? "For example Jazz" : "Text to match"}
              list={rule.field === "genre" ? listId : undefined}
              value={rule.a}
              onChange={(e) => onChange({ ...rule, a: e.target.value })}
            />
            {rule.field === "genre" && (
              <datalist id={listId}>
                {genres.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            )}
          </>
        )}
        {info.type === "bool" && (
          <select
            className="text-input"
            aria-label="Value"
            value={rule.a}
            onChange={(e) => onChange({ ...rule, a: e.target.value })}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        )}
        {(info.type === "number" || (info.type === "date" && rule.op !== "never")) && (
          <>
            <input
              className="text-input"
              aria-label={rule.op === "between" ? "From" : "Value"}
              type="number"
              inputMode="decimal"
              step="any"
              value={rule.a}
              onChange={(e) => onChange({ ...rule, a: e.target.value })}
            />
            {rule.op === "between" && (
              <>
                <span className="muted small">and</span>
                <input
                  className="text-input"
                  aria-label="To"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={rule.b}
                  onChange={(e) => onChange({ ...rule, b: e.target.value })}
                />
              </>
            )}
            <span className="muted small">{info.type === "date" ? "days" : (info.unit ?? info.hint ?? "")}</span>
          </>
        )}
      </div>
      <button className="icon-btn sp-remove" aria-label="Remove this rule" onClick={onRemove}>
        <TrashIcon size={18} />
      </button>
    </div>
  );
}

function Editor({
  initial,
  saved,
  onClose,
}: {
  initial: Draft;
  saved: SavedPlaylist | null;
  onClose: (changed: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = useLoad(() => call<Meta>("api/smart-playlists/meta"), []);
  const playQueue = usePlayer((s) => s.playQueue);

  const definition = useMemo(() => toDefinition(draft), [draft]);
  const key = JSON.stringify(definition);
  const [preview, setPreview] = useState<Evaluated | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);

  // A live count while editing, once typing pauses.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      call<Evaluated>("api/smart-playlists/preview", {
        method: "POST",
        body: JSON.stringify({ definition: JSON.parse(key) as Definition }),
      })
        .then((r) => !cancelled && (setPreview(r), setPreviewError(null)))
        .catch((err) => !cancelled && setPreviewError(err));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setRule = (k: string, r: DraftRule) => set({ rules: draft.rules.map((x) => (x.key === k ? r : x)) });
  const warnings = missingData(draft, meta.data?.coverage ?? null);
  const incomplete = incompleteRules(draft);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name, definition };
      if (saved) await send("PUT", `api/smart-playlists/${saved.id}`, body);
      else await send("POST", "api/smart-playlists", body);
      onClose(true);
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title={saved ? "Edit smart playlist" : "New smart playlist"}
      subtitle="Songs that match your rules are added automatically, now and as your library changes."
    >
      <div className="stack sp-editor">
        <div>
          <label className="field-label" htmlFor="sp-name">
            Name
          </label>
          <input
            id="sp-name"
            className="text-input"
            value={draft.name}
            maxLength={80}
            placeholder="For example Sunday jazz"
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>

        {!saved && (
          <div>
            <label className="field-label" htmlFor="sp-template">
              Start from
            </label>
            <select
              id="sp-template"
              className="text-input"
              value=""
              onChange={(e) => {
                const t = TEMPLATES.find((x) => x.id === e.target.value);
                if (t) setDraft(fromDefinition(draft.name || t.name, t.definition));
              }}
            >
              <option value="">
                Choose a starting point&hellip;
              </option>
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="sp-match">
          <span>Songs that match</span>
          <div className="segmented" role="radiogroup" aria-label="Match all or any rule">
            {(["all", "any"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={draft.match === m}
                className={draft.match === m ? "on" : ""}
                onClick={() => set({ match: m })}
              >
                {m === "all" ? "All rules" : "Any rule"}
              </button>
            ))}
          </div>
        </div>

        <div className="sl-list">
          {draft.rules.map((r) => (
            <RuleEditor
              key={r.key}
              rule={r}
              genres={meta.data?.genres ?? []}
              onChange={(x) => setRule(r.key, x)}
              onRemove={() => set({ rules: draft.rules.filter((x) => x.key !== r.key) })}
            />
          ))}
          {draft.rules.length === 0 && <p className="muted small">No rules: every song in your library matches.</p>}
        </div>
        <div>
          <button className="btn" disabled={draft.rules.length >= 20} onClick={() => set({ rules: [...draft.rules, newRule()] })}>
            <PlusIcon size={16} /> Add rule
          </button>
        </div>

        <div className="sp-options">
          <div>
            <label className="field-label" htmlFor="sp-sort">
              Order by
            </label>
            <div className="row">
              <select
                id="sp-sort"
                className="text-input"
                value={draft.sortBy}
                onChange={(e) => set({ sortBy: e.target.value as SortField })}
              >
                {(Object.keys(SORT_LABELS) as SortField[]).map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
              </select>
              {draft.sortBy !== "random" && (
                <select
                  className="text-input"
                  aria-label="Direction"
                  value={draft.sortDir}
                  onChange={(e) => set({ sortDir: e.target.value as "asc" | "desc" })}
                >
                  <option value="asc">Low to high</option>
                  <option value="desc">High to low</option>
                </select>
              )}
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="sp-limit">
              Maximum songs
            </label>
            <input
              id="sp-limit"
              className="text-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={5000}
              placeholder="No limit"
              value={draft.limit}
              onChange={(e) => set({ limit: e.target.value })}
            />
          </div>
        </div>

        {warnings.map((w) => (
          <p key={w} className="notice">
            {w}
          </p>
        ))}
        {incomplete > 0 && <p className="muted small">{pluralize(incomplete, "rule")} not filled in yet, so left out for now.</p>}

        <div className="card pad sp-preview" aria-live="polite">
          <strong>
            {preview
              ? `${preview.total.toLocaleString()} ${preview.total === 1 ? "song matches" : "songs match"}`
              : "Counting…"}
          </strong>
          {preview && preview.items.length > 0 && (
            <ul className="muted small">
              {preview.items.slice(0, 5).map((i) => (
                <li key={i.id}>
                  {i.title}
                  {i.artist ? ` · ${i.artist}` : ""}
                </li>
              ))}
              {preview.total > 5 && <li>and more&hellip;</li>}
            </ul>
          )}
          {preview && preview.items.length > 0 && (
            <div className="sl-actions">
              <button className="btn" onClick={() => void playQueue(toTracks(preview.items), 0)}>
                <PlayIcon size={16} /> Try it
              </button>
            </div>
          )}
          <ErrorNotice error={previewError} />
        </div>

        {error && <p className="notice error">{error}</p>}
        <div className="sl-actions sp-save">
          <button className="btn primary" disabled={busy || draft.name.trim() === ""} onClick={() => void save()}>
            {saved ? "Save changes" : "Create playlist"}
          </button>
          <button className="btn ghost" onClick={() => onClose(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Page>
  );
}

function Detail({
  playlist,
  onBack,
  onEdit,
  onDeleted,
}: {
  playlist: SavedPlaylist;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const playQueue = usePlayer((s) => s.playQueue);
  // One shuffle order per visit, so the list shown is the list that plays.
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const list = useLoad(
    () => call<Evaluated>(`api/smart-playlists/${playlist.id}/tracks?seed=${seed}&limit=500`),
    [playlist.id, playlist.updatedAt, seed],
  );
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tracks = useMemo(() => toTracks(list.data?.items ?? []), [list.data]);

  const playAll = async () => {
    try {
      const all =
        tracks.length >= 500 ? await call<Evaluated>(`api/smart-playlists/${playlist.id}/tracks?seed=${seed}&limit=5000`) : null;
      void playQueue(all ? toTracks(all.items) : tracks, 0);
    } catch (err) {
      setError(explainError(err));
    }
  };

  const remove = async () => {
    if (!confirm) return setConfirm(true);
    try {
      await send("DELETE", `api/smart-playlists/${playlist.id}`);
      onDeleted();
    } catch (err) {
      setError(explainError(err));
    }
  };

  return (
    <Page title={playlist.name} subtitle={describeDefinition(playlist.definition)}>
      <div className="sl-toolbar">
        <button className="btn ghost" onClick={onBack}>
          All smart playlists
        </button>
        <button className="btn primary" disabled={tracks.length === 0} onClick={() => void playAll()}>
          <PlayIcon size={16} /> Play
        </button>
        <button className="btn" onClick={onEdit}>
          Edit rules
        </button>
        <button className={`btn${confirm ? " danger" : " ghost"}`} onClick={() => void remove()} onBlur={() => setConfirm(false)}>
          {confirm ? "Tap again to delete" : "Delete"}
        </button>
      </div>
      {error && <p className="notice error">{error}</p>}
      <ErrorNotice error={list.error} />
      {list.data && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          {pluralize(list.data.total, "song")}
          {list.data.total > list.data.items.length ? `, showing ${list.data.items.length}` : ""}
        </p>
      )}
      {list.loading && !list.data && (
        <p className="empty">Finding songs&hellip;</p>
      )}
      {list.data && list.data.items.length === 0 && <p className="empty">No songs match these rules right now.</p>}
      <div className="track-list">
        {tracks.map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} queue={tracks} />
        ))}
      </div>
    </Page>
  );
}

type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "edit"; id: string | null };

function Body() {
  const [view, setView] = useState<View>({ kind: "list" });
  const lists = useLoad(() => call<{ items: SavedPlaylist[] }>("api/smart-playlists"), []);
  const items = lists.data?.items ?? [];
  const current =
    view.kind === "list" ? null : (items.find((p) => p.id === (view.kind === "detail" ? view.id : view.id)) ?? null);

  if (view.kind === "edit") {
    const initial = current ? fromDefinition(current.name, current.definition) : emptyDraft();
    return (
      <Editor
        key={current?.id ?? "new"}
        initial={initial}
        saved={current}
        onClose={(changed) => {
          if (changed) lists.reload();
          setView(current && !changed ? { kind: "detail", id: current.id } : { kind: "list" });
        }}
      />
    );
  }
  if (view.kind === "detail" && current) {
    return (
      <Detail
        playlist={current}
        onBack={() => setView({ kind: "list" })}
        onEdit={() => setView({ kind: "edit", id: current.id })}
        onDeleted={() => {
          lists.reload();
          setView({ kind: "list" });
        }}
      />
    );
  }

  return (
    <Page
      title="Smart playlists"
      subtitle="Playlists that fill themselves from rules: genre, year, how often you play them, tempo and more."
    >
      <div className="sl-toolbar">
        <button className="btn primary" onClick={() => setView({ kind: "edit", id: null })}>
          <PlusIcon size={16} /> New smart playlist
        </button>
      </div>
      <ErrorNotice error={lists.error} />
      {lists.loading && !lists.data && (
        <p className="empty">Loading&hellip;</p>
      )}
      {lists.data && items.length === 0 && (
        <p className="empty">No smart playlists yet. Create one, or start from a ready-made idea like Recently added.</p>
      )}
      <div className="sl-list">
        {items.map((p) => (
          <button key={p.id} className="card sl-item sp-open" onClick={() => setView({ kind: "detail", id: p.id })}>
            <h3>{p.name}</h3>
            <span className="muted small">{describeDefinition(p.definition)}</span>
          </button>
        ))}
      </div>
    </Page>
  );
}

export function SmartPlaylistsPage() {
  return (
    <Gate>
      <Body />
    </Gate>
  );
}
