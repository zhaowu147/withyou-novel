import { Workspace } from "@/app/(main)/_components/workspace";

export default async function StudioSessionPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  return <Workspace initialConversationId={conversationId} />;
}
