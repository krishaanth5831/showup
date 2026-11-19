// Small presentational pieces used on several screens. Server-rendered, no state.

import { Barbell, Check, Moon, PersonSimpleRun, X } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";
import type { Kind } from "@/lib/engine";
import type { DayState } from "@/lib/views";

export function KindIcon({ kind, size = 18 }: { kind: Kind | null; size?: number }) {
  if (kind === "run") return <PersonSimpleRun size={size} weight="bold" aria-hidden />;
  if (kind === "strength") return <Barbell size={size} weight="bold" aria-hidden />;
  return <Moon size={size} weight="bold" aria-hidden />;
}

export function kindLabel(kind: Kind | null): string {
  return kind === "run" ? "Run" : kind === "strength" ? "Strength" : "Rest";
}

const STATE_WORD: Record<DayState, string> = {
  done: "done",
  missed: "missed",
  due: "due today",
  checking: "being checked",
  upcoming: "coming up",
  rest: "rest day",
};

/** The round marker for one day: solid ink = done, red = missed, ring = still open. */
export function DayDot({ state, kind, big = false }: { state: DayState; kind: Kind | null; big?: boolean }) {
  const size = big ? "size-12" : "size-10";
  const icon = big ? 22 : 18;
  const base = `flex ${size} items-center justify-center rounded-full`;
  const label = `${kindLabel(kind)}, ${STATE_WORD[state]}`;
  if (state === "done")
    return (
      <span role="img" aria-label={label} className={`${base} bg-ink text-on-ink`}>
        <Check size={icon} weight="bold" aria-hidden />
      </span>
    );
  if (state === "missed")
    return (
      <span role="img" aria-label={label} className={`${base} bg-accent text-on-accent`}>
        <X size={icon} weight="bold" aria-hidden />
      </span>
    );
  if (state === "rest")
    return (
      <span role="img" aria-label={label} className={`${base} text-muted`}>
        <span className="size-1.5 rounded-full bg-line" />
      </span>
    );
  const ring = state === "due" ? "border-2 border-ink text-ink" : state === "checking" ? "border-2 border-dashed border-muted text-muted" : "border border-line text-muted";
  return (
    <span role="img" aria-label={label} className={`${base} ${ring}`}>
      <KindIcon kind={kind} size={icon} />
    </span>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-line py-8">
      <h2 className="mb-5 text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "accent" | "ink" }) {
  const cls = tone === "accent" ? "bg-accent text-on-accent" : tone === "ink" ? "bg-ink text-on-ink" : "border border-line text-muted";
  return <span className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium whitespace-nowrap ${cls}`}>{children}</span>;
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6 pt-2" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-5 w-40" />
      <div className="skeleton h-56 w-full rounded-[20px]" />
      <div className="skeleton h-20 w-full" />
      <div className="skeleton h-24 w-full" />
    </div>
  );
}
