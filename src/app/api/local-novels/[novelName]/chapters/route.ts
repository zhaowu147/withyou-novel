import { type NextRequest, NextResponse } from "next/server";

import { novelFS } from "@/lib/novel-fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/local-novels/[novelName]/chapters
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ novelName: string }> }) {
  const { novelName } = await params;
  if (!novelName) return NextResponse.json({ error: "novelName required" }, { status: 400 });

  try {
    const chapters = novelFS.listChapters(novelName);
    return NextResponse.json({
      success: true,
      data: chapters.map((ch) => ({
        number: ch.number,
        title: ch.title,
        wordCount: ch.size,
        updatedAt: ch.updatedAt,
      })),
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: (err as Error).message || "Failed to list chapters" }, { status: 500 });
  }
}
