/** @type {import('next').NextConfig} */
const nextConfig = {
  // 交付形态：next build 产出 .next/standalone，启动器跑 node server.js（勿用 next dev）。
  // ⚠️ 启动器必须设 WITHYOU_DATA_DIR 指向用户数据目录，否则双击启动时 cwd 不定、数据漂移。
  output: "standalone",
  // Pi 包含运行时扩展加载器，必须由 Node 直接加载，不能被 Turbopack 静态改写。
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ],
  // 源码维护路由会在运行时扫描用户授权的工作区。禁止 NFT 在构建机上
  // 把当前仓库、用户小说和构建产物误判为该路由的静态依赖。
  outputFileTracingExcludes: {
    "/**/*": [
      ".electron-build/**/*",
      ".data/**/*",
      ".git/**/*",
      ".next/build/**/*",
      ".next/cache/**/*",
      ".next/diagnostics/**/*",
      ".next/standalone/**/*",
      ".next/static/**/*",
      ".next/types/**/*",
      ".next/turbopack/**/*",
      "data/**/*",
      "docs/**/*",
      "electron/**/*",
      "novels/**/*",
      "public/**/*",
      "release/**/*",
      "src/**/*",
      "tests/**/*",
      "tmp/**/*",
      "*",
    ],
  },
  compiler: {
    // 保留 error/warn：app-paths 的数据根告警与 json-db 的损坏告警必须能到达生产日志。
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },

  // 安全响应头
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
