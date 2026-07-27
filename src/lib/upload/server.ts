/**
 * 服务端本地图片写入 public/uploads
 */
import "server-only";

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface UploadError {
  code: string;
  message: string;
}

export interface UploadResult {
  url: string;
  path: string;
}

export function validateFile(file: { type: string; size: number }): UploadError | null {
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

function detectImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function uploadsDir() {
  return path.join(/* turbopackIgnore: true */ process.cwd(), "public", "uploads");
}

export async function saveUploadBuffer(bytes: Buffer, _originalName: string, mimeType: string): Promise<UploadResult> {
  const err = validateFile({ type: mimeType, size: bytes.length });
  if (err) throw new Error(err.message);
  const detectedType = detectImageType(bytes);
  if (!detectedType || detectedType !== mimeType) throw new Error("文件内容与声明的图片格式不一致");

  const dir = uploadsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ext = TYPE_EXTENSIONS[detectedType];
  const rel = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, rel), bytes);
  return { url: `/uploads/${rel}`, path: rel };
}

export async function deleteImage(relPath: string): Promise<void> {
  const full = path.join(uploadsDir(), path.basename(relPath));
  if (fs.existsSync(full)) fs.unlinkSync(full);
}
