"use client";

/**
 * Khoá API cho MCP (G5): tạo, xem, thu hồi. Khoá gốc chỉ hiện MỘT lần ngay sau khi tạo — server
 * chỉ giữ hash. Kèm lệnh nối Claude Code, cùng cách Palmier hướng dẫn cài MCP.
 */

import { useEffect, useState } from "react";

import { ApiError, api, jsonBody } from "../api";
import { Skeleton } from "../Skeleton";

type Key = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "never");

export function ApiKeys() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api<{ keys: Key[] }>("/api-keys")
      .then((body) => setKeys(body.keys))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your API keys."));

  useEffect(() => {
    void load();
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api<Key & { key: string }>("/api-keys", jsonBody({ name: name.trim() }));
      setCreated(made.key);
      setCopied(false);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the key.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: Key) => {
    setError(null);
    try {
      await api(`/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke the key.");
    }
  };

  const endpoint = typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`;
  const command = created ? `claude mcp add --transport http opencmo ${endpoint} --header "Authorization: Bearer ${created}"` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const active = (keys ?? []).filter((key) => !key.revoked_at);

  return (
    <div className="settings-card" data-testid="api-keys">
      <h2>API keys</h2>
      <p>
        Connect Claude, Cursor or another MCP client to edit your clips. Generating media from a client still shows you the
        price first. Anyone with a key can edit your projects and spend your credits: keep it private.
      </p>
      {created ? (
        <div className="api-key-created" role="status">
          <p>
            <strong>Copy this key now.</strong> It is shown only once.
          </p>
          <code className="api-key-value" data-testid="api-key-created">
            {created}
          </code>
          <p className="field-hint">Add it to Claude Code:</p>
          <code className="api-key-value">{command}</code>
          <button type="button" className="secondary-button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy command"}
          </button>
        </div>
      ) : null}
      <form className="api-key-form" onSubmit={(event) => void create(event)}>
        <label htmlFor="api-key-name">Key name</label>
        <input id="api-key-name" data-testid="api-key-name" value={name} maxLength={60} placeholder="Claude Desktop" onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="secondary-button" disabled={!name.trim() || busy} data-testid="api-key-create">
          Create key
        </button>
      </form>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {keys === null ? (
        <Skeleton height={40} radius="var(--ds-radius-lg)" />
      ) : active.length ? (
        <ul className="acct-list" data-testid="api-key-list">
          {active.map((key) => (
            <li key={key.id}>
              <strong>{key.name}</strong> <code>{key.prefix}…</code> · last used {day(key.last_used_at)}{" "}
              <button type="button" className="link-button" onClick={() => void revoke(key)} data-testid={`api-key-revoke-${key.prefix}`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">No keys yet.</p>
      )}
    </div>
  );
}
