// start-dev.js — restart Next.js dev server (avoids fnm env issues)
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");

const NEXT_BIN = path.join(__dirname, "node_modules", "next", "dist", "bin", "next");

// kill anything on common ports
[3000, 3001, 3002].forEach((port) => {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const pids = new Set();
    out.split("\n").forEach((line) => {
      const m = line.trim().match(/(\d+)$/);
      if (m) pids.add(m[1]);
    });
    pids.forEach((pid) => {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {}
    });
  } catch {}
});

console.log("[start-dev] ports cleared, starting next dev...");
const child = spawn("node", [NEXT_BIN, "dev"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code || 0));
