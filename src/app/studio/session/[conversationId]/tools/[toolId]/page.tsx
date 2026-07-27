import { Workspace } from "@/app/(main)/_components/workspace";

export default async function StudioSessionToolPage({
  params,
}: {
  params: Promise<{ conversationId: string; toolId: string }>;
}) {
  const { conversationId, toolId } = await params;
  return <Workspace initialConversationId={conversationId} initialToolId={toolId} />;
}
