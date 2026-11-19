import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { LoginForm } from "@/app/ui/auth-forms";
import { hasPassword, isLoggedIn } from "@/lib/auth";
import { getDb } from "@/lib/db";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-sm flex-col justify-center gap-8 px-5 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tighter">Showup</h1>
        <p className="text-muted">Show up for your workouts, or pay up.</p>
      </div>
      <Suspense fallback={<div className="skeleton h-40 w-full" />}>
        <Gate />
      </Suspense>
    </main>
  );
}

async function Gate() {
  await connection();
  const db = await getDb();
  if (!(await hasPassword(db))) redirect("/setup");
  if (await isLoggedIn(db)) redirect("/");
  return <LoginForm />;
}
