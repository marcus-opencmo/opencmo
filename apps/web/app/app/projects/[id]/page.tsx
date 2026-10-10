import { ProjectView } from "@/components/clipping/web/ProjectView";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ brief?: string | string[] }>;
}) {
  const { id } = await params;
  const { brief } = await searchParams;
  // A video brief the founder approved in the CMO's Approvals: it opens in the project assistant.
  const briefId = typeof brief === "string" && /^[0-9a-f-]{36}$/i.test(brief) ? brief : null;
  return <ProjectView projectId={id} briefId={briefId} />;
}
