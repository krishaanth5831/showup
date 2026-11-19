// Shared class names. Kept outside the client components so server-rendered
// pages can use the same button look for plain links.

const BUTTON = {
  solid: "px-5 bg-ink text-on-ink hover:opacity-90",
  outline: "px-5 border border-line bg-surface text-ink hover:border-ink",
  danger: "px-5 bg-accent text-on-accent hover:opacity-90",
  quiet: "text-muted underline underline-offset-4 hover:text-ink",
};

export type ButtonVariant = keyof typeof BUTTON;

export function buttonClass(variant: ButtonVariant = "solid"): string {
  return `inline-flex h-11 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 ${BUTTON[variant]}`;
}
