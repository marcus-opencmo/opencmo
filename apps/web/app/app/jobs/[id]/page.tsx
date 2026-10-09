import { permanentRedirect } from "next/navigation";

/**
 * Link cũ `/app/jobs/<id>` (bản cloud trước D3) chuyển hẳn sang trang project.
 * 308 chứ không phải 307: đường này không quay lại, và bookmark/link đã chia sẻ
 * phải cập nhật.
 */
export default async function LegacyJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/app/projects/${id}`);
}
