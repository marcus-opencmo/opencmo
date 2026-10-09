import { CATEGORIES, findCategory } from "@/content/blog/categories";
import { OG_SIZE, ogCard } from "@/lib/og/card";

export const alt = "OpenCMO Blog category";
export const size = OG_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return CATEGORIES.map((c) => ({ category: c.slug }));
}

export default async function Image({ params }: { params: Promise<{ category: string }> }) {
  const category = findCategory((await params).category);
  return ogCard({
    kicker: "OpenCMO Blog",
    title: category ? `${category.name}: guides and playbooks` : "OpenCMO Blog",
    footer: "opencmo.io/blog",
  });
}
