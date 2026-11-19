import { Suspense } from "react";
import { markIncomingAction } from "@/app/actions";
import { DayDot, PageSkeleton, Section, kindLabel } from "@/app/ui/bits";
import { ActionForm, Submit } from "@/app/ui/forms";
import { requireUser } from "@/lib/auth";
import { euros } from "@/lib/engine";
import { longDate, shortDate } from "@/lib/time";
import { type HistoryRow, history } from "@/lib/views";

export default function HistoryPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <HistoryContent />
    </Suspense>
  );
}

function moneyLine(row: HistoryRow): string | null {
  if (row.status !== "missed") return null;
  if (row.practice) return `Practice. Would have cost ${euros(row.chargeCents)}.`;
  if (!row.penalty) return row.rawCents > 0 ? "Weekly cap reached, so nothing was charged." : null;
  const p = row.penalty;
  if (p.status === "returned") return `${p.friendName} gave it back.`;
  if (p.status === "held") {
    const part = p.returnedCents > 0 ? ` ${euros(p.returnedCents)} is back already.` : "";
    if (p.releasable) return `${p.friendName} can send it back now.${part}`;
    return `${p.friendName} holds it until ${p.releaseOn ? shortDate(p.releaseOn) : "later"}.${part}`;
  }
  return `Not sent yet.${p.error ? ` ${p.error}` : ""}`;
}

async function HistoryContent() {
  const db = await requireUser();
  const h = await history(db, new Date());
  const friend = h.friendName || "your friend";

  return (
    <div className="rise flex flex-col pt-2">
      <h1 className="mb-6 text-4xl font-semibold tracking-tighter">History</h1>
      <dl className="grid grid-cols-3 pb-8">
        {[
          ["Charged in total", h.totals.everCents],
          [`With ${friend} now`, h.totals.heldCents],
          ["Given back", h.totals.returnedCents],
        ].map(([label, cents]) => (
          <div key={label as string} className="flex flex-col gap-1 pr-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="num text-2xl font-semibold">{euros(cents as number)}</dd>
          </div>
        ))}
      </dl>

      {h.weeks.length === 0 && (
        <div className="rounded-[20px] border border-line bg-surface p-6">
          <p className="font-medium">Nothing judged yet.</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Each training day gets its verdict at 03:00 the next morning. Come back after your first one.
          </p>
        </div>
      )}

      {h.weeks.map((w) => (
        <section key={w.monday} className="border-t border-line py-6">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Week of {longDate(w.monday)}</h2>
            {w.chargedCents > 0 && <span className="num text-sm text-accent">{euros(w.chargedCents)}</span>}
          </div>
          <ul className="flex flex-col gap-4">
            {w.rows.map((row) => {
              const line = moneyLine(row);
              return (
                <li key={row.date} className="flex items-start gap-4">
                  <DayDot state={row.status} kind={row.kind} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                    <p className="text-sm font-medium">
                      {shortDate(row.date)}
                      <span className="font-normal text-muted">
                        {" "}
                        {kindLabel(row.kind)}
                        {row.status === "done" ? (row.source === "proof" ? ", screenshot" : ", Strava") : row.streak > 1 ? `, miss ${row.streak} in a row` : ""}
                      </span>
                    </p>
                    {line && <p className="text-sm leading-snug text-muted">{line}</p>}
                    {row.note && <p className="text-sm leading-snug text-muted">{row.note}</p>}
                  </div>
                  {row.status === "missed" && row.chargeCents > 0 && (
                    <span className={`num pt-0.5 text-sm font-medium ${row.practice ? "text-muted" : "text-accent"}`}>{euros(row.chargeCents)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {h.incoming.length > 0 && (
        <Section title={`Money from ${friend}`}>
          <p className="mb-5 text-sm leading-relaxed text-muted">
            A transfer counts as giving a penalty back when its description mentions &quot;showup&quot;. Mark the others by hand if they were meant as a return.
          </p>
          <ul className="flex flex-col gap-5">
            {h.incoming.map((i) => (
              <li key={i.id} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {shortDate(i.date)} <span className="font-normal text-muted">{i.description || "no description"}</span>
                  </p>
                  <span className="num text-sm font-medium">{euros(i.amountCents)}</span>
                </div>
                <ActionForm action={markIncomingAction} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="isReturn" value={i.isReturn ? "no" : "yes"} />
                  <span className="text-sm text-muted">{i.isReturn ? "Counted as a return." : "Not counted."}</span>
                  <Submit variant="quiet">{i.isReturn ? "Don't count it" : "Count it as a return"}</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
