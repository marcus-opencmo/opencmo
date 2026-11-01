"use client";

import { useEffect, useState } from "react";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import { Button } from "@/components/ui";

import { ErrorNote, Panel } from "../parts";

type Notify = { emailDigest: boolean; push: boolean; vapidPublicKey: string | null };
type PushState = "unsupported" | "needs_home_screen" | "denied" | "off" | "on" | "busy";

/** The VAPID key as the bytes `pushManager.subscribe` wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** iPhone and iPad only deliver push to a site added to the Home Screen and opened from there (iOS 16.4+). */
function needsHomeScreen(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

/**
 * Email and push (P6 C0, C1). Both only tell the founder that cards wait; the card is decided in the app. Push is per
 * browser, so the button speaks of "this device".
 */
export function NotifyPanel() {
  const [settings, setSettings] = useState<Notify | null>(null);
  const [push, setPush] = useState<PushState>("busy");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Notify>("/notify")
      .then(async (value) => {
        if (!alive) return;
        setSettings(value);
        if (!value.vapidPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
          setPush(needsHomeScreenSafe() ? "needs_home_screen" : "unsupported");
          return;
        }
        if (Notification.permission === "denied") return setPush("denied");
        setPush((await currentSubscription()) ? "on" : "off");
      })
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err.message : "Could not load your notification settings."));
    return () => {
      alive = false;
    };
  }, []);

  async function saveEmail(on: boolean) {
    if (!settings) return;
    setError(null);
    try {
      setSettings({ ...settings, ...(await api<Pick<Notify, "emailDigest" | "push">>("/notify", jsonBody({ emailDigest: on, push: settings.push }, "PUT"))) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
    }
  }

  async function turnPushOn() {
    if (!settings?.vapidPublicKey) return;
    setError(null);
    setPush("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setPush(permission === "denied" ? "denied" : "off");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(settings.vapidPublicKey) }));
      await api("/notify/push", jsonBody(subscription.toJSON(), "POST"));
      if (!settings.push) setSettings({ ...settings, ...(await api<Pick<Notify, "emailDigest" | "push">>("/notify", jsonBody({ emailDigest: settings.emailDigest, push: true }, "PUT"))) });
      setPush("on");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "This browser did not turn push on. Try again, or use email.");
      setPush((await currentSubscription().catch(() => null)) ? "on" : "off");
    }
  }

  async function turnPushOff() {
    setError(null);
    setPush("busy");
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        await api("/notify/push", jsonBody({ endpoint: subscription.endpoint }, "DELETE"));
        await subscription.unsubscribe();
      }
      setPush("off");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not turn push off. Try again.");
      setPush("on");
    }
  }

  return (
    <Panel id="settings-notify" title="Notifications" sub="They only tell you that cards wait. You decide in the app, never from an email or a push.">
      <div className="v2-panel-body scr-form">
        {settings ? (
          <>
            <div className="v2-field">
              <span>Email</span>
              {settings.emailDigest ? (
                <span className="scr-inline-field">
                  <span className="scr-small">On: the morning email at the hour set above, and one before a post&apos;s time runs out.</span>
                  <Button compact variant="secondary" onClick={() => void saveEmail(false)}>
                    Stop emails
                  </Button>
                </span>
              ) : (
                <span className="scr-inline-field">
                  <span className="scr-small">Off. Cards still wait for you here.</span>
                  <Button compact variant="secondary" onClick={() => void saveEmail(true)}>
                    Turn emails on
                  </Button>
                </span>
              )}
            </div>
            <div className="v2-field" data-testid="push-setting">
              <span>Push on this device</span>
              {push === "on" ? (
                <span className="scr-inline-field">
                  <span className="scr-small">On: one push when new cards wait.</span>
                  <Button compact variant="secondary" onClick={() => void turnPushOff()}>
                    Turn off
                  </Button>
                </span>
              ) : push === "off" ? (
                <span className="scr-inline-field">
                  <span className="scr-small">Your browser asks you first.</span>
                  <Button compact variant="secondary" onClick={() => void turnPushOn()}>
                    Turn on
                  </Button>
                </span>
              ) : push === "busy" ? (
                <span className="scr-small scr-muted">Checking…</span>
              ) : push === "denied" ? (
                <span className="scr-small">This browser blocks notifications from OpenCMO. Allow them in the browser&apos;s site settings, then come back.</span>
              ) : push === "needs_home_screen" ? (
                <span className="scr-small">
                  On iPhone and iPad, add OpenCMO to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn push on in Settings. Email works everywhere.
                </span>
              ) : (
                <span className="scr-small">This browser cannot get push from OpenCMO. Email works everywhere.</span>
              )}
            </div>
          </>
        ) : !error ? (
          <span className="scr-small scr-muted">Loading…</span>
        ) : null}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Panel>
  );
}

function needsHomeScreenSafe(): boolean {
  try {
    return needsHomeScreen();
  } catch {
    return false;
  }
}
