import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Showup",
    short_name: "Showup",
    description: "Show up for your workouts, or pay up.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f0f11",
    theme_color: "#0f0f11",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
