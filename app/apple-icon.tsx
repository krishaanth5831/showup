import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Home-screen icon: the Pact mark from icon.svg (two linked rings, you and your friend).
// Square corners here, because the phone rounds the icon itself.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={180} height={180}>
        <rect width="64" height="64" fill="#18181b" />
        <circle cx="25" cy="32" r="12" fill="none" stroke="#fafafa" strokeWidth="5.5" />
        <circle cx="39" cy="32" r="12" fill="none" stroke="#ff6166" strokeWidth="5.5" />
        <path d="M34.83 38.88 A12 12 0 0 1 28.11 43.59" fill="none" stroke="#fafafa" strokeWidth="5.5" />
      </svg>
    ),
    size,
  );
}
