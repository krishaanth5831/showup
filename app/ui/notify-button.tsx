"use client";

// Turns on push notifications for the friend's phone. On an iPhone, web pages can only get
// notifications after they were added to the Home Screen and opened from there.

import { Bell } from "@phosphor-icons/react";
import { useEffect, useState, useTransition } from "react";
import type { FormState } from "@/app/actions";
import { subscribeAction } from "@/app/friend-actions";
import { Message } from "./forms";
import { buttonClass } from "./styles";

type Support = "checking" | "on" | "off" | "denied" | "ios-install" | "unsupported";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function NotifyButton({ token, publicKey }: { token: string; publicKey: string }) {
  const [support, setSupport] = useState<Support>("checking");
  const [state, setState] = useState<FormState>({});
  const [working, start] = useTransition();

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setSupport(isIos() && !standalone() ? "ios-install" : "unsupported");
        return;
      }
      if (isIos() && !standalone()) return setSupport("ios-install");
      if (Notification.permission === "denied") return setSupport("denied");
      const reg = await navigator.serviceWorker.register("/sw.js");
      setSupport((await reg.pushManager.getSubscription()) && Notification.permission === "granted" ? "on" : "off");
    })().catch(() => setSupport("unsupported"));
  }, []);

  function turnOn() {
    start(async () => {
      try {
        if ((await Notification.requestPermission()) !== "granted") {
          setSupport("denied");
          return;
        }
        const reg = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
        const res = await subscribeAction(token, sub.toJSON());
        setState(res);
        if (res.ok) setSupport("on");
      } catch (e) {
        setState({ error: `Notifications could not be turned on (${(e as Error).message}).` });
      }
    });
  }

  if (support === "checking") return null;
  if (support === "ios-install") {
    return (
      <p className="max-w-[60ch] text-sm leading-relaxed text-muted">
        To get notifications on an iPhone: tap the Share button, choose &quot;Add to Home Screen&quot;, open Showup from your Home Screen, and turn
        notifications on there.
      </p>
    );
  }
  if (support === "unsupported") return <p className="text-sm text-muted">This browser can&apos;t show notifications. Try Chrome or Safari on your phone.</p>;
  if (support === "denied") {
    return <p className="text-sm text-muted">Notifications are blocked for this page. Allow them in the browser&apos;s site settings, then reload.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {support === "on" ? (
        <p className="text-sm">Notifications are on for this phone.</p>
      ) : (
        <div>
          <button type="button" disabled={working} onClick={turnOn} className={buttonClass("solid")}>
            <Bell size={18} weight="bold" aria-hidden />
            {working ? "Turning on" : "Turn on notifications"}
          </button>
        </div>
      )}
      <Message state={state} />
    </div>
  );
}
