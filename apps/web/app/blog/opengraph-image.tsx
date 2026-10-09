import { OG_SIZE, ogCard } from "@/lib/og/card";

export const alt = "OpenCMO Blog";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogCard({ kicker: "OpenCMO Blog", title: "Notes on marketing for founders.", footer: "opencmo.io/blog" });
}
