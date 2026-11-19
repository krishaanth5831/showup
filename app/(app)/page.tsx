import { Warning } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Suspense } from "react";
import { Chip, DayDot, PageSkeleton, kindLabel } from "@/app/ui/bits";
import { Countdown } from "@/app/ui/countdown";
import { ProofUpload } from "@/app/ui/proof-upload";
import { requireUser } from "@/lib/auth";
import { euros, km } from "@/lib/engine";
import { dayName, longDate, shortDate, weekdayLabel, weekdayOf } from "@/lib/time";
import { type Dashboard, type TodayView, dashboard } from "@/lib/views";
import { freshen } from "@/lib/work";

export default function TodayPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Today />
    </Suspense>
  );
}

async function Today() {
  const db = await requireUser();
  const now = new Date();
  await freshen(db, now);
  const d = await dashboard(db, now);
  const friend = d.friendName || "your friend";

  return (
    <div className="rise flex flex-col gap-8 pt-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {dayName(d.today.date)}, {longDate(d.today.date)}
        </p>
        {d.mode === "armed" ? <Chip tone="ink">Real money</Chip> : <Chip>{d.armsOn ? `Real money from ${shortDate(d.armsOn)}` : "Practice"}</Chip>}
      </div>

      {d.alerts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {d.alerts.map((a) => (
            <li key={a.text} className="flex items-start gap-3 rounded-[20px] border border-line bg-surface p-4 text-sm leading-snug">
              {a.tone === "warn" && <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-accent" aria-hidden />}
              <span className="flex-1">{a.text}</span>
              {a.href && (
                <Link href={a.href} className="shrink-0 font-medium underline underline-offset-4">
                  {a.action}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <TodayCard t={d.today} d={d} friend={friend} />

      <section aria-label="This week">
        <ol className="grid grid-cols-7 gap-1">
          {d.week.map((day) => (
            <li key={day.date} className="flex flex-col items-center gap-2">
              <span className={`text-xs ${day.isToday ? "font-semibold text-ink" : "text-muted"}`}>{weekdayLabel(weekdayOf(day.date)).slice(0, 3)}</span>
              <DayDot state={day.state} kind={day.kind} />
              <span className={`num h-4 text-xs ${day.practice ? "text-muted" : "text-accent"}`}>
                {day.state === "missed" && day.chargeCents > 0 ? euros(day.chargeCents) : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <dl className="grid grid-cols-3 border-t border-line pt-6">
        <Figure
          label="Next miss"
          value={euros(d.nextMissCents)}
          note={d.missStreak > 0 ? `${d.missStreak} missed in a row` : "no misses in a row"}
          hot={d.missStreak > 0}
        />
        <Figure label="This week" value={euros(d.weekChargedCents)} note={`of ${euros(d.rules.capPerWeekCents)} at most`} hot={d.weekChargedCents > 0 && d.mode === "armed"} />
        <Figure label={d.friendName ? `${d.friendName} holds` : "Your friend holds"} value={euros(d.heldCents)} note={d.owedCents > 0 ? `${euros(d.owedCents)} not sent yet` : `for ${d.rules.holdDays} days each`} />
      </dl>
      {d.mode === "practice" && (
        <p className="text-sm leading-relaxed text-muted">
          Practice mode: everything is tracked and the amounts show what a miss would cost, but no money moves. Switch on real money in{" "}
          <Link href="/settings" className="text-ink underline underline-offset-4">
            Settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, note, hot = false }: { label: string; value: string; note: string; hot?: boolean }) {
  return (
    <div className="flex flex-col gap-1 pr-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num text-2xl font-semibold ${hot ? "text-accent" : ""}`}>{value}</dd>
      <dd className="text-xs leading-snug text-muted">{note}</dd>
    </div>
  );
}

function TodayCard({ t, d, friend }: { t: TodayView; d: Dashboard; friend: string }) {
  const target = t.kind === "run" ? `${d.rules.minRunKm} km` : null;
  const stake =
    d.mode === "armed" ? `Miss it and ${euros(t.costIfMissedCents)} goes to ${friend}.` : `In practice mode. A miss would cost ${euros(t.costIfMissedCents)}.`;
  // Just after midnight a screenshot can still count for yesterday's strength session.
  const lateUpload = t.uploadFor && t.uploadFor !== t.date ? t.uploadFor : null;

  return (
    <section className="rounded-[20px] border border-line bg-surface p-6">
      {t.kind === null ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <DayDot state="rest" kind={null} big />
            <h1 className="text-4xl font-semibold tracking-tighter">Rest day</h1>
          </div>
          <p className="text-muted">Nothing is due today.</p>
        </div>
      ) : t.state === "done" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <DayDot state="done" kind={t.kind} big />
            <h1 className="text-4xl font-semibold tracking-tighter">{kindLabel(t.kind)} done</h1>
          </div>
          <p className="text-muted">
            {t.source === "strava" && t.activity
              ? t.kind === "run"
                ? `${km(t.activity.distanceM)} km at ${t.activity.startTime}, recorded on Strava.`
                : `${Math.round(t.activity.elapsedS / 60)} min at ${t.activity.startTime}, recorded on Strava.`
              : "Screenshot received."}
          </p>
          {t.source === "proof" && t.proofId && (
            <div className="flex flex-col gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/proof/${t.proofId}`} alt="Uploaded workout screenshot" className="max-h-72 w-auto self-start rounded-xl border border-line" />
              {t.uploadFor === t.date && <ProofUpload label="Replace screenshot" replace />}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <DayDot state={t.state} kind={t.kind} big />
            <h1 className="text-4xl font-semibold tracking-tighter">
              {kindLabel(t.kind)}
              {target ? <span className="text-muted"> {target}</span> : null}
            </h1>
          </div>
          <p className="text-lg">
            Due before midnight. <Countdown deadline={t.deadline} />
          </p>
          <p className={d.mode === "armed" ? "font-medium text-accent" : "text-muted"}>{stake}</p>
          {t.hint && <p className="text-sm text-muted">{t.hint}</p>}
          {t.kind === "run" ? (
            <p className="text-sm text-muted">Record it with Strava. It shows up here by itself a few minutes after it syncs.</p>
          ) : (
            t.uploadFor === t.date && <ProofUpload label="Upload watch screenshot" replace={false} />
          )}
        </div>
      )}
      {lateUpload && (
        <div className="mt-6 flex flex-col gap-3 border-t border-line pt-6">
          <p className="text-sm">
            Yesterday&apos;s strength session ({shortDate(lateUpload)}) can still be proven until 03:00.
          </p>
          <ProofUpload label="Upload yesterday's screenshot" replace={false} />
        </div>
      )}
    </section>
  );
}
