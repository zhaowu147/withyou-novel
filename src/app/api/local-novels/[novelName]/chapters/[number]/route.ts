import { type NextRequest, NextResponse } from "next/server";

import { novelFS } from "@/lib/novel-fs";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/local-novels/[novelName]/chapters/[number]
 * 读取指定章节的正文内容
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ novelName: string; number: string }> }) {
  const { novelName, number } = await params;
  if (!novelName || !number) {
    return NextResponse.json({ error: "novelName and number required" }, { status: 400 });
  }

  const num = parseInt(number, 10);
  if (Number.isNaN(num) || num < 1) {
    return NextResponse.json({ error: "invalid chapter number" }, { status: 400 });
  }

  try {
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelName);
    const content = novelFS.readChapter(novelName, num);
    if (content === null) {
      return NextResponse.json({ error: "chapter not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: { content, number: num } });
  } catch (err: unknown) {
    const ownershipResponse = workspaceErrorResponse(err);
    if (ownershipResponse) return ownershipResponse;
    return NextResponse.json({ error: (err as Error).message || "Failed to read chapter" }, { status: 500 });
  }
}

/**
 * PUT /api/local-novels/[novelName]/chapters/[number]
 * 更新章节正文(写入文件系统)
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ novelName: string; number: string }> }) {
  const { novelName, number } = await params;
  if (!novelName || !number) {
    return NextResponse.json({ error: "novelName and number required" }, { status: 400 });
  }

  const num = parseInt(number, 10);
  if (Number.isNaN(num) || num < 1) {
    return NextResponse.json({ error: "invalid chapter number" }, { status: 400 });
  }

  try {
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelName);
    const body = await req.json();
    const { content, title } = body as { content: string; title?: string };

    if (!content || typeof content !== "string") {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }

    let chapterTitle = title;
    if (!chapterTitle) {
      const existing = novelFS.readChapter(novelName, num);
      if (existing) {
        const m = existing.match(/^#\s*(.+)$/m);
        if (m) chapterTitle = m[1].trim();
      }
    }
    if (!chapterTitle) chapterTitle = `第${num}章`;

    novelFS.writeChapter(novelName, num, chapterTitle, content);

    return NextResponse.json({ success: true, data: { number: num, title: chapterTitle } });
  } catch (err: unknown) {
    const ownershipResponse = workspaceErrorResponse(err);
    if (ownershipResponse) return ownershipResponse;
    return NextResponse.json({ error: (err as Error).message || "Failed to save chapter" }, { status: 500 });
  }
}
