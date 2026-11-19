"use client";

// The interactive parts of the Settings screen.

import { Copy } from "@phosphor-icons/react";
import { useState } from "react";
import { connectBunqAction, saveRulesAction, saveStravaAppAction } from "@/app/actions";
import type { Rules } from "@/lib/engine";
import { WEEKDAYS, weekdayLabel } from "@/lib/time";
import { ActionForm, Field, Submit } from "./forms";
import { buttonClass } from "./styles";

export function StravaAppForm({ clientId }: { clientId: string }) {
  return (
    <ActionForm action={saveStravaAppAction} className="flex flex-col gap-5">
      <Field label="Client ID" name="clientId" inputMode="numeric" defaultValue={clientId} autoComplete="off" required />
      <Field label="Client secret" name="clientSecret" type="password" autoComplete="off" required hint="Stored encrypted. It is never shown again." />
      <div>
        <Submit variant="outline" busy="Saving">
          Save Strava keys
        </Submit>
      </div>
    </ActionForm>
  );
}

export function BunqForm() {
  return (
    <ActionForm action={connectBunqAction} className="flex flex-col gap-5">
      <Field label="bunq API key" name="apiKey" type="password" autoComplete="off" required hint="Stored encrypted. It is never shown again." />
      <div>
        <Submit busy="Connecting">Connect bunq</Submit>
      </div>
    </ActionForm>
  );
}

const SELECT = "h-11 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink focus:border-ink focus:outline-none";

export function RulesForm({ rules, locked, lockDays }: { rules: Rules; locked: boolean; lockDays: number }) {
  return (
    <ActionForm action={saveRulesAction} className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-5">
        <legend className="mb-4 text-sm font-medium">Who holds the money</legend>
        <Field label="Friend's full name" name="friendName" defaultValue={rules.friendName} autoComplete="off" hint="Exactly as it is on the bank account. Banks check that the name matches the IBAN." />
        <Field label="Friend's IBAN" name="friendIban" defaultValue={rules.friendIban} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      </fieldset>

      <fieldset>
        <legend className="mb-4 text-sm font-medium">Training days</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          {WEEKDAYS.map((day) => (
            <label key={day} className="flex flex-col gap-2">
              <span className="text-sm text-muted">{weekdayLabel(day)}</span>
              <select name={`day_${day}`} defaultValue={rules.schedule[day] ?? "rest"} className={SELECT}>
                <option value="rest">Rest</option>
                <option value="run">Run</option>
                <option value="strength">Strength</option>
              </select>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-4 text-sm font-medium">What counts</legend>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Shortest run (km)" name="minRunKm" inputMode="decimal" defaultValue={rules.minRunKm} required />
          <Field label="Shortest workout (min)" name="minStrengthMin" inputMode="numeric" defaultValue={rules.minStrengthMin} required />
        </div>
        <p className="mt-2 text-sm leading-snug text-muted">The workout length only applies to strength sessions found on Strava. A screenshot always counts.</p>
      </fieldset>

      <fieldset>
        <legend className="mb-4 text-sm font-medium">What a miss costs</legend>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First miss (€)" name="base" inputMode="decimal" defaultValue={rules.baseCents / 100} required />
          <Field label="Multiplier per miss in a row" name="multiplier" inputMode="decimal" defaultValue={rules.multiplier} required />
          <Field label="Most for one miss (€)" name="capMiss" inputMode="decimal" defaultValue={rules.capPerMissCents / 100} required />
          <Field label="Most in one week (€)" name="capWeek" inputMode="decimal" defaultValue={rules.capPerWeekCents / 100} required />
          <Field label="Friend holds it for (days)" name="holdDays" inputMode="numeric" defaultValue={rules.holdDays} required />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-4 text-sm font-medium">Sick days</legend>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Sick days per month" name="sickDays" inputMode="numeric" defaultValue={rules.sickDaysPerMonth} required />
        </div>
        <p className="mt-2 text-sm leading-snug text-muted">
          A sick day costs nothing and leaves the multiplier where it was. It is used on the training day itself, and it comes back if you train
          anyway. Enter 0 to switch sick days off.
        </p>
      </fieldset>

      <div className="flex flex-col gap-3">
        {locked && (
          <p className="text-sm leading-snug text-muted">
            Real money is on, so a change only starts {lockDays} days after you save it. That stops you from lowering the stakes on a weak day.
          </p>
        )}
        <div>
          <Submit busy="Saving">Save rules</Submit>
        </div>
      </div>
    </ActionForm>
  );
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <p className="num rounded-xl border border-line bg-surface p-3 text-sm break-all">{url}</p>
      <div>
        <button
          type="button"
          className={buttonClass("outline")}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy size={18} weight="bold" aria-hidden />
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
