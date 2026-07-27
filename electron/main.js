const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");

const PORT = 19721; // 固定端口，避免冲突
const isDev = !app.isPackaged;

// ── 数据目录 ──────────────────────────────────────────────────────────────────
// 打包后：用户应用数据目录，避免升级或卸载程序覆盖小说数据
// 开发时：项目根目录的 data/
const dataDir = isDev
  ? path.join(__dirname, "..", "data")
  : path.join(app.getPath("userData"), "data");

// ── 环境变量 ──────────────────────────────────────────────────────────────────
// 从 exe 同目录的 .env.local 加载密钥（运行时读取，不打包）
function loadEnvLocal() {
  const envPath = isDev
    ? path.join(__dirname, "..", ".env.local")
    : path.join(app.getPath("userData"), ".env.local");

  if (!fs.existsSync(envPath)) {
    console.warn("[withyou] .env.local 不存在，部分功能可能不可用");
    return;
  }

  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ── 启动 Next.js 服务器 ──────────────────────────────────────────────────────
let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = isDev
      ? path.join(__dirname, "..", ".next", "standalone", "server.js")
      : path.join(process.resourcesPath, "standalone", "server.js");

    if (!fs.existsSync(serverPath)) {
      reject(new Error(`server.js 不存在: ${serverPath}`));
      return;
    }

    // 复制静态资源到 standalone（首次运行时）
    const standaloneDir = path.dirname(serverPath);
    const runtimeDependencies = path.join(standaloneDir, "runtime-deps");
    const staticSrc = isDev
      ? path.join(__dirname, "..", ".next", "static")
      : path.join(process.resourcesPath, "standalone", ".next", "static");
    const staticDst = path.join(standaloneDir, ".next", "static");

    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
      fs.cpSync(staticSrc, staticDst, { recursive: true });
    }

    // 复制 public 目录
    const publicSrc = isDev
      ? path.join(__dirname, "..", "public")
      : path.join(process.resourcesPath, "standalone", "public");
    const publicDst = path.join(standaloneDir, "public");

    if (fs.existsSync(publicSrc) && !fs.existsSync(publicDst)) {
      fs.cpSync(publicSrc, publicDst, { recursive: true });
    }

    const env = {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      WITHYOU_DATA_DIR: dataDir,
      NODE_ENV: "production",
      NODE_PATH: runtimeDependencies,
      // Electron 的 process.execPath 在打包后仍是应用 EXE；要求它以 Node
      // 子进程运行 standalone server，避免子进程再次启动 Electron 窗口。
      ELECTRON_RUN_AS_NODE: "1",
    };

    serverProcess = spawn(process.execPath, [serverPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    serverProcess.stdout.on("data", (d) => {
      const s = d.toString();
      console.log("[server]", s);
      if (s.includes("Ready") || s.includes("started") || s.includes(`${PORT}`)) {
        resolve();
      }
    });

    serverProcess.stderr.on("data", (d) => {
      console.error("[server:err]", d.toString());
    });

    serverProcess.on("error", reject);
    serverProcess.on("exit", (code) => {
      console.log(`[server] 进程退出: ${code}`);
      serverProcess = null;
    });

    // 超时兜底：10 秒后无论怎样都 resolve
    setTimeout(resolve, 10000);
  });
}

// ── 等待服务器就绪 ────────────────────────────────────────────────────────────
function waitForServer(url, maxRetries = 30) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const check = () => {
      http
        .get(url, (res) => {
          if (res.statusCode < 500) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry);
    };
    const retry = () => {
      if (++retries > maxRetries) {
        reject(new Error("服务器启动超时"));
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// ── 窗口 ─────────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "WithYou Novel",
    icon: isDev ? path.join(__dirname, "icon.ico") : path.join(process.resourcesPath, "icon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    // 去掉原生菜单栏
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── 应用生命周期 ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  loadEnvLocal();

  try {
    await startServer();
    await waitForServer(`http://127.0.0.1:${PORT}`);
    createWindow();
  } catch (err) {
    console.error("[withyou] 启动失败:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// 优雅退出
process.on("SIGINT", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
process.on("SIGTERM", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
