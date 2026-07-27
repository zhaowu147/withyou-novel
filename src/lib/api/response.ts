import { NextResponse } from "next/server";

/**
 * Unified API response helpers.
 * All API routes should use these to ensure consistent response format.
 */

export function apiSuccess<T>(data: T) {
  return NextResponse.json({ success: true, data });
}

export function apiError(message: string, status = 400, code?: string) {
  return NextResponse.json({ success: false, error: { code: code || "ERROR", message } }, { status });
}

export function apiUnauthorized() {
  return apiError("Unauthorized", 401, "UNAUTHORIZED");
}
