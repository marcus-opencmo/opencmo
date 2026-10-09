import { PageSkeleton } from "@/components/clipping/Skeleton";

/**
 * Ranh giới riêng cho một project: ranh giới ở `app/app/` nằm TRÊN segment bị
 * đổi khi đi từ `/app/projects` vào `/app/projects/<id>`, nên nó không kích
 * hoạt cho bước đó.
 */
export default function ProjectLoading() {
  return <PageSkeleton variant="project" />;
}
