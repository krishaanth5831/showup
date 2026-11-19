"use client";

import { ClockCounterClockwise, GearSix, House } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Today", Icon: House },
  { href: "/history", label: "History", Icon: ClockCounterClockwise },
  { href: "/settings", label: "Settings", Icon: GearSix },
];

/** Bottom tab bar on phones, a plain row at the top on wider screens. */
export function Nav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:static md:border-0 md:bg-transparent md:pb-0"
    >
      <ul className="mx-auto flex max-w-xl items-stretch justify-around px-2 md:max-w-none md:justify-end md:gap-1 md:px-0">
        {ITEMS.map(({ href, label, Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <li key={href} className="flex-1 md:flex-none">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition md:h-10 md:flex-row md:gap-2 md:rounded-full md:px-4 md:text-sm ${
                  active ? "text-ink md:bg-ink md:text-on-ink" : "text-muted hover:text-ink"
                }`}
              >
                <Icon size={22} weight={active ? "fill" : "regular"} aria-hidden className="md:hidden" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
