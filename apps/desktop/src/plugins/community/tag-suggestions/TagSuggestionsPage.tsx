import { useState } from "react";
import { explainError, send, useLoad, call, pluralize } from "../_serverlib/api";
import { ErrorNotice, Gate, Page, Tabs } from "../_serverlib/ui";
import { FIELD_NAMES, ruleName, type Status, type Suggestion, type SuggestionList } from "./types";

const PAGE = 50;

function Card({ s, onDone, onError }: { s: Suggestion; onDone: () => void; onError: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(s.newValue);
  const [busy, setBusy] = useState(false);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await send("POST", `api/tag-suggestions/${s.id}/${path}`, body ?? {});
      onDone();
    } catch (err) {
      onError(explainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card sl-item">
      <div className="muted small">
        {s.trackTitle || "Track"}
        {s.trackArtist ? ` · ${s.trackArtist}` : ""}
      </div>
      <div className="sl-diff">
        <span className="muted">{FIELD_NAMES[s.field]}</span>
        <span className="old">{s.oldValue ?? "(empty)"}</span>
        <span />
        {editing ? (
          <input
            className="text-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`New ${FIELD_NAMES[s.field]}`}
          />
        ) : (
          <span className="new">{s.newValue}</span>
        )}
      </div>
      <div>
        {s.rule.split(",").map((r) => (
          <span key={r} className="sl-tag">
            {ruleName(r)}
          </span>
        ))}
      </div>
      <div className="sl-path">{s.relPath}</div>
      {s.status === "pending" && (
        <div className="sl-actions">
          <button
            className="btn primary"
            disabled={busy || value.trim() === ""}
            onClick={() => void act("accept", editing ? { value } : {})}
          >
            Accept
          </button>
          <button className="btn" disabled={busy} onClick={() => setEditing((e) => !e)}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void act("reject")}>
            Dismiss
          </button>
        </div>
      )}
      {s.status === "accepted" && (
        <div className="sl-actions">
          <button className="btn" disabled={busy} onClick={() => void act("revert")}>
            Undo
          </button>
        </div>
      )}
    </article>
  );
}

function Body() {
  const [status, setStatus] = useState<Status>("pending");
  const [rule, setRule] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = useLoad(
    () =>
      call<SuggestionList>(
        `api/tag-suggestions?status=${status}&limit=${limit}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}`,
      ),
    [status, rule, limit],
  );
  const data = list.data;
  const pending = data?.byStatus.pending ?? 0;
  const rules = Object.entries(data?.pendingByRule ?? {});

  const rescan = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await send<{ pending: number; created: number }>("POST", "api/tag-suggestions/scan");
      setMessage(
        r.pending === 0 ? "Your tags look tidy: nothing to suggest." : `${pluralize(r.pending, "suggestion")} ready to review.`,
      );
      list.reload();
    } catch (err) {
      setMessage(explainError(err));
    } finally {
      setBusy(false);
    }
  };

  const acceptAll = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setBusy(true);
    try {
      const r = await send<{ accepted: number }>("POST", "api/tag-suggestions/accept", rule ? { rule } : { all: true });
      setMessage(`${pluralize(r.accepted, "suggestion")} accepted. You can undo any of them under Accepted.`);
      list.reload();
    } catch (err) {
      setMessage(explainError(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = data?.items ?? [];

  return (
    <>
      <div className="sl-toolbar">
        <button className="btn primary" disabled={busy} onClick={() => void rescan()}>
          Check library
        </button>
        {status === "pending" && shown.length > 0 && (
          <button
            className={`btn${confirm ? " danger" : ""}`}
            disabled={busy}
            onClick={() => void acceptAll()}
            onBlur={() => setConfirm(false)}
          >
            {confirm ? `Tap again to accept ${rule ? ruleName(rule) : "all"}` : `Accept all${rule ? `: ${ruleName(rule)}` : ""}`}
          </button>
        )}
        {data && <span className="muted small">{pluralize(data.overlays, "saved fix", "saved fixes")}</span>}
      </div>
      {message && <p className="notice">{message}</p>}
      <ErrorNotice error={list.error} />

      <Tabs
        value={status}
        onChange={(s) => {
          setStatus(s);
          setLimit(PAGE);
        }}
        items={[
          { id: "pending", label: "To review", count: data?.byStatus.pending },
          { id: "accepted", label: "Accepted", count: data?.byStatus.accepted },
          { id: "rejected", label: "Dismissed", count: data?.byStatus.rejected },
        ]}
      />
      {status === "pending" && rules.length > 0 && (
        <div className="sl-toolbar">
          <select
            className="text-input grow"
            aria-label="Filter by kind of fix"
            value={rule}
            onChange={(e) => {
              setRule(e.target.value);
              setLimit(PAGE);
            }}
          >
            <option value="">All kinds of fix ({pending})</option>
            {rules.map(([r, n]) => (
              <option key={r} value={r}>
                {ruleName(r)} ({n})
              </option>
            ))}
          </select>
        </div>
      )}

      {list.loading && !data && <p className="empty">Loading&hellip;</p>}
      {data && shown.length === 0 && (
        <p className="empty">
          {status === "pending" ? "No suggestions. Press Check library to look again." : "Nothing here yet."}
        </p>
      )}
      <div className="sl-list">
        {shown.map((s) => (
          <Card key={s.id} s={s} onDone={list.reload} onError={setMessage} />
        ))}
      </div>
      {data && data.total > shown.length && (
        <div className="sl-more">
          <button className="btn" onClick={() => setLimit(Math.min(500, limit + PAGE))}>
            Show more ({data.total - shown.length} left)
          </button>
        </div>
      )}
    </>
  );
}

export function TagSuggestionsPage() {
  return (
    <Page
      title="Tag suggestions"
      subtitle="Proposed clean-ups for capitalisation, feat. credits, album artists and track numbers. Accepting one saves it on the server only; your music files are never touched."
    >
      <Gate admin>
        <Body />
      </Gate>
    </Page>
  );
}
