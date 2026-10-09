import { redirect } from "next/navigation";

/** Link cũ của editor (nút Edit, CMO video pack, bookmark) → `/app/editor/<clip>` (E0). */
export default async function EditClipPage({ params }: { params: Promise<{ id: string; clipId: string }> }) {
  const { clipId } = await params;
  redirect(`/app/editor/${clipId}`);
}
