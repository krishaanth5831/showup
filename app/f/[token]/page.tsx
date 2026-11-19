// The friend's page: the money being held, when each transfer is due back and where to send it.
// Reached through a secret link, read-only, no login.

import crypto from "node:crypto";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton, Section } from "@/app/ui/bits";
import { getDb } from "@/lib/db";
import { euros, prettyIban } from "@/lib/engine";
import { kvGet } from "@/lib/kv";
import { longDate, shortDate } from "@/lib/time";
import { friendView } from "@/lib/views";

export default function FriendPage({ params }: PageProps<"/f/[token]">) {
  return (
    <main className="mx-auto w-full max-w-xl px-5 py-10">
      <Suspense fallback={<PageSkeleton />}>
        <Friend params={params} />
      </Suspense>
    </main>
  );
}

async function Friend({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const db = await getDb();
  const real = await kvGet<string>(db, "friend_token");
  const a = Buffer.from(token);
  const b = Buffer.from(real ?? "");
  if (!real || a.length !== b.length || !crypto.timingSafeEqual(a, b)) notFound();

  const v = await friendView(db, new Date());
  const owner = v.ownerName || "your friend";

  return (
    <div className="rise flex flex-col">
      <p className="text-sm text-muted">Showup{v.friendName ? `, for ${v.friendName}` : ""}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tighter">
        You are holding <span className="num">{euros(v.heldCents)}</span>
      </h1>
      <p className="mt-4 max-w-[60ch] leading-relaxed text-muted">
        Every time {owner} skips a planned workout, a penalty lands on your account. Keep each one for {v.holdDays} days, then send it back. Do not
        send anything back early, however nicely you are asked.
      </p>
      {v.sick.limit > 0 && (
        <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
          Sick days cost nothing. {v.sick.used} of {v.sick.limit} used in {v.sick.month}.
        </p>
      )}

      <dl className="mt-8 grid grid-cols-3 border-t border-line pt-6">
        <div className="flex flex-col gap-1 pr-3">
          <dt className="text-xs text-muted">Ready to send back</dt>
          <dd className={`num text-2xl font-semibold ${v.dueCents > 0 ? "text-accent" : ""}`}>{euros(v.dueCents)}</dd>
        </div>
        <div className="flex flex-col gap-1 pr-3">
          <dt className="text-xs text-muted">Sent back so far</dt>
          <dd className="num text-2xl font-semibold">{euros(v.returnedCents)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted">On its way to you</dt>
          <dd className="num text-2xl font-semibold">{euros(v.owedCents)}</dd>
        </div>
      </dl>

      <div className="mt-8">
        <Section title="How to send it back">
          {v.ownerIban ? (
            <dl className="flex flex-col gap-4 rounded-[20px] border border-line bg-surface p-6 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-muted">To</dt>
                <dd className="font-medium">{v.ownerName}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted">IBAN</dt>
                <dd className="num text-base font-medium break-all">{prettyIban(v.ownerIban)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted">Description</dt>
                <dd className="font-medium">Showup</dd>
                <dd className="leading-snug text-muted">The word &quot;Showup&quot; is how the transfer gets recognised.</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted">The return account has not been set up yet.</p>
          )}
        </Section>

        <Section title="Transfers">
          {v.transfers.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">Nothing yet. No workout has been skipped since this started.</p>
          ) : (
            <ul className="flex flex-col gap-5">
              {v.transfers.map((t) => (
                <li key={t.date} className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">{t.sentOn ? `Sent ${shortDate(t.sentOn)}` : `For ${shortDate(t.date)}`}</p>
                    <p className="text-sm leading-snug text-muted">
                      {t.status === "returned"
                        ? "Sent back."
                        : t.status === "owed"
                          ? "Not sent to you yet."
                          : t.due
                            ? `Ready to send back${t.returnedCents ? `, ${euros(t.amountCents - t.returnedCents)} left` : ""}.`
                            : `Hold until ${t.releaseOn ? longDate(t.releaseOn) : "later"}.`}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className="num text-sm font-medium">{euros(t.amountCents)}</span>
                    {t.due && <span className="text-xs font-medium text-accent">Due back</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {v.proofs.length > 0 && (
          <Section title="Strength workout screenshots">
            <p className="mb-5 text-sm leading-relaxed text-muted">Uploaded as proof in the last five weeks. Say something if one looks off.</p>
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {v.proofs.map((p) => (
                <li key={p.id} className="flex flex-col gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/proof/${p.id}?t=${token}`} alt={`Workout screenshot for ${shortDate(p.date)}`} loading="lazy" className="aspect-[3/4] w-full rounded-xl border border-line object-cover" />
                  <span className="text-xs text-muted">{shortDate(p.date)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
