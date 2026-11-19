import Link from "next/link";
import { PactMark } from "@/app/ui/logo";
import { Nav } from "@/app/ui/nav";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-xl flex-col px-5 pb-28 md:max-w-2xl md:pb-16">
      <header className="flex h-16 items-center justify-between md:h-20">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <PactMark className="h-5 w-auto shrink-0" />
          Showup
        </Link>
        <Nav />
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
