import Link from "next/link";
import { Nav } from "@/app/ui/nav";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-xl flex-col px-5 pb-28 md:max-w-2xl md:pb-16">
      <header className="flex h-16 items-center justify-between md:h-20">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Showup
        </Link>
        <Nav />
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
