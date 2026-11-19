"use client";

import { loginAction, setupAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "./forms";

export function LoginForm() {
  return (
    <ActionForm action={loginAction} className="flex flex-col gap-5">
      <Field label="Password" name="password" type="password" autoComplete="current-password" required autoFocus />
      <div>
        <Submit busy="Checking">Sign in</Submit>
      </div>
    </ActionForm>
  );
}

export function SetupForm() {
  return (
    <ActionForm action={setupAction} className="flex flex-col gap-5">
      <Field label="Choose a password" name="password" type="password" autoComplete="new-password" minLength={10} required hint="At least 10 characters. It protects your bank connection." />
      <Field label="Type it again" name="again" type="password" autoComplete="new-password" minLength={10} required />
      <div>
        <Submit busy="Saving">Create password</Submit>
      </div>
    </ActionForm>
  );
}
