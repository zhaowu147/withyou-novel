/**
 * 客户端可用的上传校验（无 Node API）
 */

export interface UploadError {
  code: string;
  message: string;
}

export interface UploadResult {
  url: string;
  path: string;
}

import { workspaceFetch } from "@/lib/workspaces/client";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function validateFile(file: File): UploadError | null {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return {
      code: "INVALID_TYPE",
      message: "不支持的文件格式，请上传 JPG、PNG 或 WebP",
    };
  }
  if (file.size > MAX_FILE_SIZE) {
    return {
      code: "FILE_TOO_LARGE",
      message: `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大 10MB`,
    };
  }
  return null;
}

/** 浏览器：POST /api/upload */
export async function uploadImage(file: File): Promise<UploadResult> {
  const err = validateFile(file);
  if (err) throw new Error(err.message);

  const body = new FormData();
  body.append("file", file);
  const res = await workspaceFetch("/api/upload", { method: "POST", body });
  const json = await res.json();
  if (!res.ok || !json?.success) {
    throw new Error(json?.error?.message || "上传失败");
  }
  return json.data as UploadResult;
}

export async function uploadImages(files: File[]): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const file of files) {
    results.push(await uploadImage(file));
  }
  return results;
}
