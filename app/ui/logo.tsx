/**
 * The Pact mark from app/icon.svg without its dark tile: two linked rings, you in the text
 * colour and your friend in red. Cropped to the rings, so it sits on a line of text.
 */
export function PactMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="10 17 44 30" fill="none" strokeWidth="5.5" aria-hidden className={className}>
      <circle cx="25" cy="32" r="12" stroke="currentColor" />
      <circle cx="39" cy="32" r="12" stroke="var(--accent)" />
      <path d="M34.83 38.88 A12 12 0 0 1 28.11 43.59" stroke="currentColor" />
    </svg>
  );
}
