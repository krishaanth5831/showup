"use client";

// Small form building blocks shared by every screen: a form that shows what the
// server answered, a submit button that shows it is working, and a two-step confirm.

import { type ReactNode, useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/app/actions";
import { type ButtonVariant, buttonClass } from "./styles";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function Message({ state }: { state: FormState }) {
  if (!state.ok && !state.error) return null;
  return (
    <p role={state.error ? "alert" : "status"} className={`text-sm leading-snug ${state.error ? "text-accent" : "text-muted"}`}>
      {state.error ?? state.ok}
    </p>
  );
}

export function ActionForm({ action, children, className = "" }: { action: Action; children: ReactNode; className?: string }) {
  const [state, run] = useActionState(action, {});
  return (
    <form action={run} className={className}>
      {children}
      <Message state={state} />
    </form>
  );
}

export function Submit({ children, variant = "solid", busy = "Working" }: { children: ReactNode; variant?: ButtonVariant; busy?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass(variant)}>
      {pending ? busy : children}
    </button>
  );
}

/** A button for actions without fields. With `confirm` it asks once more before doing it. */
export function ActionButton({
  action,
  children,
  variant = "outline",
  confirm,
  busy,
}: {
  action: (prev: FormState) => Promise<FormState>;
  children: ReactNode;
  variant?: ButtonVariant;
  confirm?: string;
  busy?: string;
}) {
  const [state, run] = useActionState(async (prev: FormState) => action(prev), {});
  const [asking, setAsking] = useState(false);
  return (
    <form action={run} onSubmit={() => setAsking(false)} className="flex flex-col gap-2">
      {confirm && asking ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-snug">{confirm}</p>
          <div className="flex flex-wrap gap-2">
            <Submit variant={variant} busy={busy}>
              Yes, do it
            </Submit>
            <button type="button" onClick={() => setAsking(false)} className={buttonClass("outline")}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirm ? (
        <div>
          <button type="button" onClick={() => setAsking(true)} className={buttonClass(variant)}>
            {children}
          </button>
        </div>
      ) : (
        <div>
          <Submit variant={variant} busy={busy}>
            {children}
          </Submit>
        </div>
      )}
      <Message state={state} />
    </form>
  );
}

export function Field({
  label,
  name,
  hint,
  ...input
}: { label: string; name: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        {...input}
        className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink placeholder:text-muted focus:border-ink focus:outline-none disabled:opacity-60"
      />
      {hint ? <span className="text-sm leading-snug text-muted">{hint}</span> : null}
    </label>
  );
}
