import type { MetadataRoute } from "next";

/**
 * The web app manifest (P6 C1): on iPhone and iPad, push reaches only a site added to the Home Screen and opened from
 * there, which needs a manifest with `display: standalone`. It opens the queue.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenCMO",
    short_name: "OpenCMO",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#f6f5f1",
    theme_color: "#2b2723",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
