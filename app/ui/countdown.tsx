"use client";

import { useEffect, useState } from "react";

function left(deadline: string): string {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return "Time is up";
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min left` : `${m} min left`;
}

/** Time until midnight, refreshed every half minute. Rendered on the client so it never shows a stale server time. */
export function Countdown({ deadline }: { deadline: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setText(left(deadline));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [deadline]);
  return <span className="whitespace-nowrap text-muted tabular-nums">{text ?? "\u00a0"}</span>;
}
