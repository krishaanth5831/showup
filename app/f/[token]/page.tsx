// The friend's version of the app: what to collect, what they hold, what goes back and
// what they keep. Reached through a secret link, no login. It can be added to the Home
// Screen as its own app (see manifest.webmanifest next to this file).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { collectedAction, givenBackAction } from "@/app/friend-actions";
import { PageSkeleton, Section, kindLabel } from "@/app/ui/bits";
import { ActionButton } from "@/app/ui/forms";
import { NotifyButton } from "@/app/ui/notify-button";
import { isFriendToken } from "@/lib/collect";
import { getDb } from "@/lib/db";
import { euros, prettyIban } from "@/lib/engine";
import { longDate, shortDate } from "@/lib/time";
import { type FriendPenalty, friendView } from "@/lib/views";

export async function generateMetadata({ params }: PageProps<"/f/[token]">): Promise<Metadata> {
  const { token } = await params;
  return {
    title: "Showup (friend)",
    manifest: `/f/${encodeURIComponent(token)}/manifest.webmanifest`,
    appleWebApp: { capable: true, title: "Showup", statusBarStyle: "default" },
  };
}

export default function FriendPage({ params }: PageProps<"/f/[token]">) {
  return (
    <main className="mx-auto w-full max-w-xl px-5 py-10">
      <Suspense fallback={<PageSkeleton />}>
        <Friend params={params} />
      </Suspense>
    </main>
  );
}

function what(p: FriendPenalty): string {
  return `${p.kind ? kindLabel(p.kind) : "Workout"} skipped on ${shortDate(p.date)}`;
}

async function Friend({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const db = await getDb();
  if (!(await isFriendToken(db, token))) notFound();

  const v = await friendView(db, new Date());
  const owner = v.ownerName || "your friend";
  const toCollect = v.penalties.filter((p) => p.status === "owed" && p.method === "friend");
  const incoming = v.penalties.filter((p) => p.status === "owed" && p.method === "bank");
  const held = v.penalties.filter((p) => p.status === "held");
  const done = v.penalties.filter((p) => p.status === "returned");
  const share = v.keepPercent > 0 ? ` You keep ${v.keepPercent}% of every penalty for yourself.` : "";

  return (
    <div className="rise flex flex-col">
      <p className="text-sm text-muted">Showup{v.friendName ? `, for ${v.friendName}` : ""}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tighter">
        {v.toCollectCents > 0 ? (
          <>
            Collect <span className="num text-accent">{euros(v.toCollectCents)}</span> from {owner}
          </>
        ) : (
          <>
            You are holding <span className="num">{euros(v.heldCents)}</span>
          </>
        )}
      </h1>
      <p className="mt-4 max-w-[60ch] leading-relaxed text-muted">
        Every time {owner} skips a planned workout, you get a notification and collect the penalty from {owner}. Keep it for {v.holdDays} days, then
        give the rest back.{share} Do not give anything back early, however nicely you are asked.
      </p>
      {v.sick.limit > 0 && (
        <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
          Sick days cost nothing. {v.sick.used} of {v.sick.limit} used in {v.sick.month}.
        </p>
      )}

      <dl className="mt-8 grid grid-cols-3 border-t border-line pt-6">
        <div className="flex flex-col gap-1 pr-3">
          <dt className="text-xs text-muted">To collect</dt>
          <dd className={`num text-2xl font-semibold ${v.toCollectCents > 0 ? "text-accent" : ""}`}>{euros(v.toCollectCents)}</dd>
        </div>
        <div className="flex flex-col gap-1 pr-3">
          <dt className="text-xs text-muted">Give back now</dt>
          <dd className={`num text-2xl font-semibold ${v.dueCents > 0 ? "text-accent" : ""}`}>{euros(v.dueCents)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted">Yours to keep</dt>
          <dd className="num text-2xl font-semibold">{euros(v.keptCents)}</dd>
        </div>
      </dl>

      <div className="mt-8">
        <Section title="Notifications">
          <div className="flex flex-col gap-4">
            <NotifyButton token={token} publicKey={v.pushKey} />
            {v.phones > 0 && (
              <p className="text-xs text-muted">
                {v.phones} phone{v.phones === 1 ? "" : "s"} get{v.phones === 1 ? "s" : ""} these notifications.
              </p>
            )}
          </div>
        </Section>

        <Section title="To collect">
          {toCollect.length === 0 && incoming.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">Nothing to collect right now.</p>
          ) : (
            <ul className="flex flex-col gap-6">
              {toCollect.map((p) => (
                <li key={p.id} className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                      <p className="text-sm font-medium">{what(p)}</p>
                      <p className="text-sm leading-snug text-muted">
                        Get {euros(p.amountCents)} from {owner}
                        {p.keepCents > 0 ? `. ${euros(p.keepCents)} of it is yours to keep.` : "."}
                      </p>
                    </div>
                    <span className="num text-sm font-medium text-accent">{euros(p.amountCents)}</span>
                  </div>
                  <ActionButton
                    action={collectedAction.bind(null, token, p.id)}
                    variant="solid"
                    confirm={`Did you get ${euros(p.amountCents)} from ${owner} for ${shortDate(p.date)}?`}
                  >
                    I&apos;ve got it
                  </ActionButton>
                </li>
              ))}
              {incoming.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">{what(p)}</p>
                    <p className="text-sm leading-snug text-muted">On its way to your account by bank transfer.</p>
                  </div>
                  <span className="num text-sm font-medium">{euros(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Holding">
          {held.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">You are not holding anything.</p>
          ) : (
            <ul className="flex flex-col gap-6">
              {held.map((p) => {
                const back = p.amountCents - p.keepCents - p.returnedCents;
                return (
                  <li key={p.id} className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium">{what(p)}</p>
                        <p className="text-sm leading-snug text-muted">
                          {p.due
                            ? `Give ${euros(back)} back now${p.keepCents > 0 ? ` and keep ${euros(p.keepCents)}` : ""}.`
                            : `Hold until ${p.releaseOn ? longDate(p.releaseOn) : "later"}. Then ${euros(back)} goes back${p.keepCents > 0 ? ` and you keep ${euros(p.keepCents)}` : ""}.`}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className="num text-sm font-medium">{euros(p.amountCents)}</span>
                        {p.due && <span className="text-xs font-medium text-accent">Due back</span>}
                      </div>
                    </div>
                    {p.due && p.method === "friend" && (
                      <ActionButton
                        action={givenBackAction.bind(null, token, p.id)}
                        variant="outline"
                        confirm={`Did you give ${euros(back)} back to ${owner}?`}
                      >
                        I&apos;ve given it back
                      </ActionButton>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="How to give it back">
          {v.ownerIban ? (
            <dl className="flex flex-col gap-4 rounded-[20px] border border-line bg-surface p-6 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-muted">To</dt>
                <dd className="font-medium">{v.ownerName || owner}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted">IBAN</dt>
                <dd className="num text-base font-medium break-all">{prettyIban(v.ownerIban)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted">Description</dt>
                <dd className="font-medium">Showup</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm leading-relaxed text-muted">By hand, the same way you collected it: cash, a bank transfer or a payment request.</p>
          )}
        </Section>

        {done.length > 0 && (
          <Section title="Given back">
            <ul className="flex flex-col gap-4">
              {done.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">{what(p)}</p>
                    <p className="text-sm leading-snug text-muted">
                      {euros(p.returnedCents)} given back{p.keepCents > 0 ? `, ${euros(p.keepCents)} kept` : ""}.
                    </p>
                  </div>
                  <span className="num text-sm font-medium">{euros(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {v.proofs.length > 0 && (
          <Section title="Workout photos">
            <p className="mb-5 text-sm leading-relaxed text-muted">
              Uploaded as proof in the last five weeks. Each one was read by Claude before it counted. Say something if one looks off.
            </p>
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {v.proofs.map((p) => (
                <li key={p.id} className="flex flex-col gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/proof/${p.id}?t=${token}`} alt={`Workout photo for ${shortDate(p.date)}`} loading="lazy" className="aspect-[3/4] w-full rounded-xl border border-line object-cover" />
                  <span className="text-xs text-muted">
                    {shortDate(p.date)}, {p.kind === "run" ? "run" : "strength"}
                  </span>
                  {p.summary ? (
                    <span className="text-xs leading-snug text-muted">{p.summary}</span>
                  ) : (
                    !p.checked && <span className="text-xs leading-snug text-muted">Not checked by Claude.</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
