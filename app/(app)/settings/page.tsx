import { headers } from "next/headers";
import { Suspense } from "react";
import {
  armAction,
  cancelPendingAction,
  checkNowAction,
  disarmAction,
  disconnectBunqAction,
  disconnectClaudeAction,
  disconnectStravaAction,
  logoutAction,
  newFriendLinkAction,
  testPaymentAction,
} from "@/app/actions";
import { Chip, PageSkeleton, Section } from "@/app/ui/bits";
import { ActionButton } from "@/app/ui/forms";
import { buttonClass } from "@/app/ui/styles";
import { BunqForm, ClaudeForm, CopyLink, RulesForm, StravaAppForm } from "@/app/ui/settings-forms";
import { requireUser } from "@/lib/auth";
import { euros, prettyIban } from "@/lib/engine";
import { originOf } from "@/lib/origin";
import { LOCK_DAYS } from "@/lib/rules";
import { localParts, longDate } from "@/lib/time";
import { settingsView } from "@/lib/views";

const STRAVA_NOTES: Record<string, string> = {
  connected: "Strava is connected.",
  denied: "Strava access was not approved, so nothing was connected.",
  expired: "That took too long. Press Connect Strava again.",
  failed: "Strava refused the connection. Check the client ID and secret, then try again.",
  missing: "Save the Strava client ID and secret first.",
};

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Settings searchParams={searchParams} />
    </Suspense>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  const p = localParts(d);
  return `${longDate(p.ymd)} at ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const db = await requireUser();
  const s = await settingsView(db, new Date());
  const note = STRAVA_NOTES[String((await searchParams).strava ?? "")];
  const origin = originOf(await headers());
  // Strava wants the bare domain here, without a port.
  const host = new URL(origin).hostname;
  const r = s.rules.current.rules;
  const friend = r.friendName || "your friend";
  const arming = !s.rules.locked && !!s.rules.pending?.rules.armed;

  return (
    <div className="rise flex flex-col pt-2">
      <h1 className="mb-6 text-4xl font-semibold tracking-tighter">Settings</h1>

      <section className="pb-8">
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight">Real money</h2>
          {s.rules.locked ? <Chip tone="ink">On</Chip> : <Chip>{arming ? "Starting soon" : "Off"}</Chip>}
        </div>
        {s.rules.locked ? (
          <div className="flex flex-col gap-4">
            <p className="max-w-[60ch] leading-relaxed text-muted">
              Every missed session sends money to {friend}. The first miss costs {euros(r.baseCents)}, and each further miss in a row multiplies it by{" "}
              {r.multiplier}, up to {euros(r.capPerMissCents)} per miss and {euros(r.capPerWeekCents)} per week.
            </p>
            {s.rules.pending ? (
              <>
                <p className="text-sm leading-snug">
                  Waiting to start on {longDate(s.rules.pending.effectiveFrom)}: {s.pendingChanges.join(", ").toLowerCase() || "updated rules"}.
                </p>
                <ActionButton action={cancelPendingAction} variant="outline">
                  Drop this change
                </ActionButton>
              </>
            ) : (
              <ActionButton
                action={disarmAction}
                variant="outline"
                confirm={`Real money keeps running for ${LOCK_DAYS} more days and stops after that. Switch it off?`}
              >
                Switch off in {LOCK_DAYS} days
              </ActionButton>
            )}
          </div>
        ) : arming ? (
          <div className="flex flex-col gap-4">
            <p className="max-w-[60ch] leading-relaxed text-muted">
              Real money starts on {longDate(s.rules.pending?.effectiveFrom ?? s.today)}. From then on, changing the rules or switching it off takes{" "}
              {LOCK_DAYS} days.
            </p>
            <ActionButton action={cancelPendingAction} variant="outline">
              Call it off
            </ActionButton>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="max-w-[60ch] leading-relaxed text-muted">
              You are in practice mode: sessions are tracked, nothing is charged. Once real money is on, missed sessions are paid to {friend}{" "}
              automatically, and changing the rules or switching it off takes {LOCK_DAYS} days.
            </p>
            {s.canArm.ok ? (
              <ActionButton
                action={armAction}
                variant="danger"
                confirm={`From tomorrow, each missed session sends ${euros(r.baseCents)} or more to ${friend}. You can't undo a penalty, and switching off takes ${LOCK_DAYS} days. Start?`}
              >
                Switch on real money
              </ActionButton>
            ) : (
              <p className="text-sm leading-snug">Before you can switch it on: {s.canArm.missing.join(", ")}.</p>
            )}
          </div>
        )}
      </section>

      <Section id="photos" title="Photo check">
        {s.claude.connected ? (
          <div className="flex flex-col gap-4">
            <p className="leading-relaxed">
              Claude checks every workout photo.{" "}
              <span className="text-muted">
                Key ending in <span className="num text-ink">{s.claude.hint}</span>
                {s.claude.connectedAt ? `, saved on ${when(s.claude.connectedAt)}.` : "."}
              </span>
            </p>
            <p className="max-w-[60ch] text-sm leading-relaxed text-muted">
              A photo counts when it shows the right kind of workout, on the right day, with the distance or length the rules ask for, and when it
              is not the same workout as an earlier photo. One that fails is not saved, and the reason is shown so you can send a better one in time.
            </p>
            <div className="flex flex-wrap gap-3">
              {!s.rules.locked && !arming && (
                <ActionButton action={disconnectClaudeAction} variant="quiet" confirm="Remove the Claude key? Photos can't be checked without it.">
                  Remove key
                </ActionButton>
              )}
            </div>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer text-ink underline underline-offset-4">Use a different key</summary>
              <div className="mt-5">
                <ClaudeForm />
              </div>
            </details>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <ol className="flex max-w-[60ch] list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
              <li>
                Open{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-4">
                  console.anthropic.com
                </a>
                , add some credit under Billing and create an API key.
              </li>
              <li>Paste it below. Each photo check costs a few cents.</li>
            </ol>
            <ClaudeForm />
          </div>
        )}
      </Section>

      <Section id="strava" title="Strava (optional)">
        {note && (
          <p role="status" className="mb-5 text-sm font-medium">
            {note}
          </p>
        )}
        {s.strava.linked ? (
          <div className="flex flex-col gap-4">
            <p className="leading-relaxed">
              Connected{s.strava.athleteName ? ` as ${s.strava.athleteName}` : ""}.{" "}
              <span className="text-muted">
                {s.strava.lastSync
                  ? s.strava.lastSync.ok
                    ? `Last read on ${when(s.strava.lastSync.at)}.`
                    : `Last try failed: ${s.strava.lastSync.error}`
                  : "Not read yet."}
              </span>
            </p>
            <div className="flex flex-wrap gap-3">
              <a href="/api/strava/connect" className={buttonClass("outline")}>
                Connect again
              </a>
              <ActionButton action={disconnectStravaAction} variant="quiet" confirm="Disconnect Strava? Photos keep working.">
                Disconnect
              </ActionButton>
            </div>
          </div>
        ) : (
          <details className="flex flex-col gap-6 text-sm text-muted">
            <summary className="cursor-pointer text-ink underline underline-offset-4">
              Not needed: photos prove every session. Connecting Strava lets runs count without a photo.
            </summary>
            <ol className="mt-5 mb-6 flex max-w-[60ch] list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
              <li>
                Open{" "}
                <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-4">
                  strava.com/settings/api
                </a>{" "}
                and create an app. Strava only allows this with a paid subscription.
              </li>
              <li>
                As Authorization Callback Domain enter <span className="num text-ink">{host}</span>
              </li>
              <li>Copy the Client ID and Client Secret into the fields below and save.</li>
              <li>Press Connect Strava and approve access, with private activities included.</li>
            </ol>
            <StravaAppForm clientId={s.strava.clientId} />
            {s.strava.hasApp && (
              <div className="mt-6">
                <a href="/api/strava/connect" className={buttonClass("solid")}>
                  Connect Strava
                </a>
              </div>
            )}
          </details>
        )}
      </Section>

      <Section id="bank" title="Bank">
        {s.bank.connected ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-medium">{s.bank.accountLabel}</p>
              {s.bank.env === "sandbox" && <Chip tone="accent">Test money</Chip>}
            </div>
            {s.bank.env === "sandbox" && (
              <p className="max-w-[60ch] text-sm leading-relaxed text-muted">
                This is bunq&apos;s test environment, so no real money moves. Connecting a real key ends the test: test penalties are dropped,
                the days so far count as practice, and real money stays off until you switch it on again.
              </p>
            )}
            <p className="text-sm leading-relaxed text-muted">
              Penalties leave from <span className="num text-ink">{prettyIban(s.bank.accountIban)}</span> ({s.bank.accountName}).{" "}
              {s.bank.lastCheck ? (s.bank.lastCheck.ok ? `Last checked on ${when(s.bank.lastCheck.at)}.` : `Last check failed: ${s.bank.lastCheck.error}`) : ""}
            </p>
            <div className="flex flex-wrap gap-3">
              <ActionButton action={testPaymentAction} variant="outline" confirm={`Send €0.01 to ${friend} to check that the name and IBAN work?`} busy="Sending">
                Send a 1 cent test
              </ActionButton>
              {!s.rules.locked && !arming && (
                <ActionButton action={disconnectBunqAction} variant="quiet" confirm="Disconnect bunq?">
                  Disconnect
                </ActionButton>
              )}
            </div>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer text-ink underline underline-offset-4">Use a different API key</summary>
              <div className="mt-5">
                <BunqForm />
              </div>
            </details>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <ol className="flex max-w-[60ch] list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
              <li>In the bunq app go to Profile, Security &amp; Settings, Developers, API keys and add a key. API keys need bunq Pro or Elite.</li>
              <li>Before pasting it anywhere, open the new key&apos;s menu and switch on &quot;Allow all IP addresses&quot;.</li>
              <li>Paste the key below straight away.</li>
            </ol>
            <BunqForm />
          </div>
        )}
      </Section>

      <Section id="rules" title="Rules">
        <RulesForm rules={r} locked={s.rules.locked} lockDays={LOCK_DAYS} />
      </Section>

      <Section title={`${friend === "your friend" ? "Your friend" : friend}'s page`}>
        <p className="mb-5 max-w-[60ch] text-sm leading-relaxed text-muted">
          A read-only page for {friend}: the money being held, when each transfer is due back and where to send it. Anyone with this link can
          open it, so share it with nobody else.
        </p>
        <div className="flex flex-col gap-4">
          <CopyLink url={origin + s.friendLink} />
          <ActionButton action={newFriendLinkAction} variant="quiet" confirm="Make a new link? The current one stops working.">
            Make a new link
          </ActionButton>
        </div>
      </Section>

      <Section title="Nightly check">
        <p className="mb-5 max-w-[60ch] text-sm leading-relaxed text-muted">
          Each training day is judged at 03:00 the next morning, and penalties are sent right after.{" "}
          {s.lastRun ? `Last check: ${when(s.lastRun.at)}.` : "It has not run yet."}
        </p>
        <ActionButton action={checkNowAction} variant="outline" busy="Checking">
          Check now
        </ActionButton>
      </Section>

      <section className="border-t border-line py-8">
        <form action={logoutAction}>
          <button type="submit" className={buttonClass("outline")}>
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}
