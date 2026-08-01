import "server-only";

import { appStateDir } from "@/lib/runtime/app-paths";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type CodingToolName = "node" | "npm" | "pnpm" | "git" | "python" | "java" | "dotnet" | "go" | "rust";

export interface CodingToolStatus {
  name: CodingToolName;
  required: boolean;
  available: boolean;
  executable?: string;
  version?: string;
  minimum?: string;
  error?: string;
}

export interface CodingEnvironmentStatus {
  platform: NodeJS.Platform;
  root: string;
  managedRoot: string;
  ready: boolean;
  tools: CodingToolStatus[];
  project?: {
    packageManager?: "pnpm" | "npm";
    dependenciesInstalled: boolean;
    pythonEnvironment?: string;
    detectedTools: CodingToolName[];
  };
  checkedAt: string;
}

export interface CodingEnvironmentInstallResult {
  status: CodingEnvironmentStatus;
  attempted: string[];
  output: string[];
  requiresUserAction: string[];
}

export interface ProjectPackageManagerInvocation {
  manager: "pnpm" | "npm" | "corepack-pnpm";
  executable: string;
  prefixArgs: string[];
  displayName: string;
}

const WINDOWS_INSTALLERS: Record<Exclude<CodingToolName, "npm" | "pnpm">, string> = {
  node: "OpenJS.NodeJS.LTS",
  git: "Git.Git",
  python: "Python.Python.3.12",
  java: "EclipseAdoptium.Temurin.21.JDK",
  dotnet: "Microsoft.DotNet.SDK.8",
  go: "GoLang.Go",
  rust: "Rustlang.Rustup",
};

function executableName(name: CodingToolName): string {
  // The Pi process can run inside Electron or a bundled Node runtime. Coding
  // commands, however, must use the user's actual CLI so its version and PATH
  // match the project package manager.
  if (name === "node") return process.platform === "win32" ? "node.exe" : "node";
  if (name === "rust") return process.platform === "win32" ? "rustc.exe" : "rustc";
  if (process.platform === "win32" && (name === "npm" || name === "pnpm")) return `${name}.cmd`;
  return name;
}

function runVersion(executable: string): { version?: string; error?: string } {
  try {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return { error: result.error.message };
    if (result.status !== 0) return { error: `${result.stderr || `退出码 ${result.status}`}`.trim() };
    const version = `${result.stdout || ""}`.trim().split(/\r?\n/)[0];
    return version ? { version } : { error: "版本信息为空" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "探测失败" };
  }
}

function findExecutable(name: CodingToolName): string | undefined {
  const candidate = executableName(name);
  if (process.platform !== "win32") {
    const result = spawnSync("which", [candidate], { encoding: "utf8", timeout: 5_000 });
    return result.status === 0 ? candidate : undefined;
  }
  const result = spawnSync("where.exe", [candidate], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.status !== 0) return undefined;
  // Return the command name instead of the localized `where.exe` path. This
  // avoids OEM-codepage corruption for usernames containing CJK characters and
  // lets Windows resolve .cmd shims through the shell.
  return candidate;
}

function findCommand(command: string): string | undefined {
  if (process.platform !== "win32") {
    const result = spawnSync("which", [command], { encoding: "utf8", timeout: 5_000 });
    return result.status === 0 ? command : undefined;
  }
  const candidate = process.platform === "win32" && !/\.(cmd|bat|exe)$/i.test(command) ? `${command}.cmd` : command;
  const result = spawnSync("where.exe", [candidate], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  return result.status === 0 ? candidate : undefined;
}

function toolStatus(name: CodingToolName): CodingToolStatus {
  const minimum = name === "node" ? ">=22" : name === "python" ? ">=3.11" : undefined;
  const executable = findExecutable(name);
  if (!executable) return { name, required: name === "node" || name === "git", available: false, minimum };
  const result = runVersion(executable);
  const versionMatch = result.version?.match(/(?:v|python )?(\d+)(?:\.(\d+))?/i);
  const major = versionMatch ? Number(versionMatch[1]) : 0;
  const minor = versionMatch ? Number(versionMatch[2] ?? 0) : 0;
  const minimumSatisfied =
    name === "node" ? major >= 22 : name === "python" ? major > 3 || (major === 3 && minor >= 11) : true;
  return {
    name,
    required: name === "node" || name === "git",
    available: Boolean(result.version) && minimumSatisfied,
    executable,
    version: result.version,
    minimum,
    error: result.error ?? (result.version && !minimumSatisfied ? `版本过低，需要 ${minimum}` : undefined),
  };
}

export function projectPackageManager(root: string): "pnpm" | "npm" | undefined {
  if (!fs.existsSync(path.join(root, "package.json"))) return undefined;
  return fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : "npm";
}

/**
 * Resolve a package manager without assuming that the user's PATH already
 * contains pnpm. Corepack is a compatibility bridge for Node installations
 * that ship pnpm support without a global pnpm command.
 */
export function resolveProjectPackageManager(root: string): ProjectPackageManagerInvocation | undefined {
  const manager = projectPackageManager(root);
  if (!manager) return undefined;
  const direct = findExecutable(manager);
  if (direct) {
    return {
      manager,
      executable: direct,
      prefixArgs: [],
      displayName: manager,
    };
  }
  if (manager === "pnpm") {
    const corepack = findCommand("corepack");
    if (corepack) {
      return {
        manager: "corepack-pnpm",
        executable: corepack,
        prefixArgs: ["pnpm"],
        displayName: "corepack pnpm",
      };
    }
  }
  return undefined;
}

function projectStatus(root: string): CodingEnvironmentStatus["project"] {
  const manager = projectPackageManager(root);
  const hasRequirements = fs.existsSync(path.join(root, "requirements.txt"));
  const hasPyProject = fs.existsSync(path.join(root, "pyproject.toml"));
  const pythonEnvironment = hasRequirements || hasPyProject ? path.join(root, ".withyou-python") : undefined;
  const pythonMarker = pythonEnvironment ? path.join(pythonEnvironment, ".withyou-requirements.sha256") : undefined;
  const requirementsHash = hasRequirements
    ? createHash("sha256")
        .update(fs.readFileSync(path.join(root, "requirements.txt")))
        .digest("hex")
    : null;
  const pythonDependenciesInstalled = Boolean(
    pythonEnvironment &&
      fs.existsSync(pythonEnvironment) &&
      (!requirementsHash ||
        (pythonMarker &&
          fs.existsSync(pythonMarker) &&
          fs.readFileSync(pythonMarker, "utf8").trim() === requirementsHash)),
  );
  const dependenciesInstalled = manager
    ? fs.existsSync(path.join(root, "node_modules"))
    : pythonEnvironment
      ? pythonDependenciesInstalled
      : false;
  const detectedTools = new Set<CodingToolName>();
  if (manager) detectedTools.add("node");
  if (pythonEnvironment) detectedTools.add("python");
  if (
    fs.existsSync(path.join(root, "pom.xml")) ||
    fs.existsSync(path.join(root, "build.gradle")) ||
    fs.existsSync(path.join(root, "build.gradle.kts"))
  )
    detectedTools.add("java");
  try {
    if (fs.readdirSync(root, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".csproj")))
      detectedTools.add("dotnet");
  } catch {
    // A workspace can disappear between request authorization and inspection.
    // Keep the tool status useful instead of turning a status check into a 500.
  }
  if (fs.existsSync(path.join(root, "go.mod"))) detectedTools.add("go");
  if (fs.existsSync(path.join(root, "Cargo.toml"))) detectedTools.add("rust");
  return manager || pythonEnvironment || detectedTools.size > 0
    ? { packageManager: manager, dependenciesInstalled, pythonEnvironment, detectedTools: [...detectedTools] }
    : undefined;
}

export function codingEnvironmentRoot(): string {
  return path.join(appStateDir(), "coding-environment");
}

export function getCodingEnvironmentStatus(root = process.cwd()): CodingEnvironmentStatus {
  const tools = (["node", "npm", "pnpm", "git", "python", "java", "dotnet", "go", "rust"] as CodingToolName[]).map(
    toolStatus,
  );
  const requiredReady = tools.filter((tool) => tool.required).every((tool) => tool.available);
  const pnpmReady = tools.find((tool) => tool.name === "pnpm")?.available;
  const npmReady = tools.find((tool) => tool.name === "npm")?.available;
  const project = projectStatus(root);
  return {
    platform: process.platform,
    root: path.resolve(root),
    managedRoot: codingEnvironmentRoot(),
    ready: requiredReady && Boolean(npmReady || pnpmReady),
    tools,
    project,
    checkedAt: new Date().toISOString(),
  };
}

function safeInstallerEnvironment(): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PRIVATE)/i.test(key)) continue;
    environment[key] = value;
  }
  return environment;
}

function runInstaller(executable: string, args: string[]): { ok: boolean; output: string } {
  try {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 15 * 60_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeInstallerEnvironment(),
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-20_000);
    return { ok: result.status === 0, output: output || (result.status === 0 ? "完成" : "失败") };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : "安装命令启动失败" };
  }
}

export function installCodingEnvironment(
  root = process.cwd(),
  requestedTools: CodingToolName[] = [],
): CodingEnvironmentInstallResult {
  const attempted: string[] = [];
  const output: string[] = [];
  const requiresUserAction: string[] = [];
  let status = getCodingEnvironmentStatus(root);

  const installTargets = new Set<CodingToolName>(["node", "git", "python", ...requestedTools]);
  if (process.platform === "win32") {
    const winget = spawnSync("where.exe", ["winget.exe"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (winget.status === 0) {
      for (const tool of status.tools) {
        if (tool.available || !installTargets.has(tool.name) || !(tool.name in WINDOWS_INSTALLERS)) continue;
        const id = WINDOWS_INSTALLERS[tool.name as keyof typeof WINDOWS_INSTALLERS];
        attempted.push(`winget install ${id}`);
        const result = runInstaller("winget.exe", [
          "install",
          "--id",
          id,
          "--exact",
          "--scope",
          "user",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ]);
        output.push(`${id}: ${result.output}`);
      }
    } else {
      requiresUserAction.push("未找到 winget，请安装 Node.js 22、Git 和 Python 3.11+ 后重新检查环境。");
    }
  } else {
    requiresUserAction.push("当前平台不提供自动系统依赖安装，请手动安装 Node.js 22、Git 和 Python 3.11+。");
  }

  status = getCodingEnvironmentStatus(root);
  const manager = status.project?.packageManager;
  if (manager && !status.project?.dependenciesInstalled) {
    let invocation = resolveProjectPackageManager(root);
    if (!invocation && manager === "pnpm") {
      const npm = findExecutable("npm");
      const corepack = findCommand("corepack");
      if (corepack) {
        invocation = {
          manager: "corepack-pnpm",
          executable: corepack,
          prefixArgs: ["pnpm"],
          displayName: "corepack pnpm",
        };
      } else if (npm) {
        attempted.push(`${npm} install --global pnpm`);
        const bootstrapped = runInstaller(npm, ["install", "--global", "pnpm"]);
        output.push(`pnpm 准备: ${bootstrapped.output}`);
        invocation = bootstrapped.ok ? resolveProjectPackageManager(root) : undefined;
      }
    }
    if (invocation) {
      const args = [...invocation.prefixArgs, "install", ...(manager === "pnpm" ? ["--frozen-lockfile"] : [])];
      attempted.push(`${invocation.displayName} ${args.slice(invocation.prefixArgs.length).join(" ")}`);
      const result = runInstaller(invocation.executable, args);
      output.push(`项目依赖: ${result.output}`);
      if (!result.ok)
        requiresUserAction.push(
          `项目依赖安装失败，请在 ${path.resolve(root)} 中运行 ${invocation.displayName} ${args.slice(invocation.prefixArgs.length).join(" ")}`,
        );
    } else {
      requiresUserAction.push(`未找到项目所需的 ${manager} 或 Corepack，请安装后重新准备依赖。`);
    }
  }

  const requirements = path.join(root, "requirements.txt");
  if (
    status.tools.find((tool) => tool.name === "python")?.available &&
    (fs.existsSync(requirements) || fs.existsSync(path.join(root, "pyproject.toml")))
  ) {
    const venv = path.join(root, ".withyou-python");
    if (!fs.existsSync(venv)) {
      attempted.push("python -m venv .withyou-python");
      const created = runInstaller(executableName("python"), ["-m", "venv", ".withyou-python"]);
      output.push(`Python venv: ${created.output}`);
    }
    const venvPython =
      process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
    const marker = path.join(venv, ".withyou-requirements.sha256");
    const requirementsHash = fs.existsSync(requirements)
      ? createHash("sha256").update(fs.readFileSync(requirements)).digest("hex")
      : null;
    const alreadyInstalled =
      requirementsHash && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === requirementsHash;
    if (requirementsHash && !alreadyInstalled && fs.existsSync(venvPython)) {
      attempted.push("python -m pip install -r requirements.txt");
      const installed = runInstaller(venvPython, [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "-r",
        "requirements.txt",
      ]);
      output.push(`Python 项目依赖: ${installed.output}`);
      if (installed.ok) fs.writeFileSync(marker, requirementsHash, "utf8");
      else requiresUserAction.push("Python 项目依赖安装失败；Pi 已保留真实输出，可根据错误继续修复。");
    }
  }

  return { status: getCodingEnvironmentStatus(root), attempted, output, requiresUserAction };
}
