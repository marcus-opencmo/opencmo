"use client";

import { useState } from "react";

/**
 * Allow / Deny: posts the answer, then goes where Supabase says (back to the app that asked). A
 * script navigation, not a form redirect: the CSP's `form-action 'self'` stops a form from
 * landing on another site. `denyOnly`: the account may not connect (free plan, unknown app), so
 * the only answer it can give is no, which still sends the app a clean `access_denied`.
 */
export function ConsentButtons({ authorizationId, denyOnly = false }: { authorizationId: string; denyOnly?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  async function decide(decision: "approve" | "deny") {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch("/api/v1/oauth/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authorization_id: authorizationId, decision }),
      });
      const body = (await response.json().catch(() => ({}))) as { redirect_url?: string | null; denied?: boolean; detail?: string };
      // Denied an app we do not support: it is not sent back there, so the page says it is done.
      if (response.ok && body.denied) {
        setDenied(true);
        setBusy(null);
        return;
      }
      if (!response.ok || !body.redirect_url) throw new Error(body.detail ?? "That did not go through. Please try again.");
      window.location.assign(body.redirect_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through. Please try again.");
      setBusy(null);
    }
  }

  if (denied) {
    return (
      <p className="auth-fields" role="status" data-testid="oauth-denied">
        Denied. Nothing was connected; you can close this page.
      </p>
    );
  }

  return (
    <>
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="auth-fields">
        {denyOnly ? null : (
          <button className="primary-button" type="button" disabled={busy !== null} onClick={() => decide("approve")} data-testid="oauth-approve">
            {busy === "approve" ? "Connecting…" : "Allow"}
          </button>
        )}
        <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => decide("deny")} data-testid="oauth-deny">
          Deny
        </button>
      </div>
    </>
  );
}
