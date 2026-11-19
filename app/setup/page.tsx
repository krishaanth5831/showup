import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SetupForm } from "@/app/ui/auth-forms";
import { hasPassword } from "@/lib/auth";
import { getDb } from "@/lib/db";

export default function SetupPage() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-sm flex-col justify-center gap-8 px-5 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tighter">Welcome to Showup</h1>
        <p className="leading-relaxed text-muted">This app is yours alone. Start by choosing the password that guards it.</p>
      </div>
      <Suspense fallback={<div className="skeleton h-56 w-full" />}>
        <Gate />
      </Suspense>
    </main>
  );
}

async function Gate() {
  await connection();
  if (await hasPassword(await getDb())) redirect("/login");
  return <SetupForm />;
}
