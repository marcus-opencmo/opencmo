import { redirect } from "next/navigation";

// Marketing plan giờ mở thành sheet ngay trong dashboard (`/app?doc=`). Trang này
// chỉ còn để link cũ (email, bookmark, `/app/cmo#strategy`) không gãy.
export default async function CmoPage({ searchParams }: { searchParams: Promise<{ site?: string; doc?: string }> }) {
  const params = await searchParams;
  if (typeof params.site === "string" && params.site) redirect(`/app?site=${encodeURIComponent(params.site.slice(0, 300))}`);
  redirect(`/app?doc=${typeof params.doc === "string" && params.doc ? encodeURIComponent(params.doc) : "product"}`);
}
