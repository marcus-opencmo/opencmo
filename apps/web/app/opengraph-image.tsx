import { OG_SIZE, ogCard } from "@/lib/og/card";

export const alt = "OpenCMO — three AI departments, one goal: customers";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogCard({ kicker: "The AI CMO for founders", title: "Three AI departments. One goal: customers.", footer: "opencmo.io" });
}
