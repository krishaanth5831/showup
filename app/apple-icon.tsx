import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Home-screen icon: a ring with a red centre, the same mark as icon.svg.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#18181b" }}>
        <div style={{ width: 100, height: 100, borderRadius: 100, border: "18px solid #fafafa", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 30, height: 30, borderRadius: 30, background: "#ff6166" }} />
        </div>
      </div>
    ),
    size,
  );
}
