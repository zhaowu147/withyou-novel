# Pi Coding Agent

Pi 现在默认就是项目级 coding agent。它使用 Pi SDK 的 read、grep、find、ls、bash 工具理解和验证源码，并使用 `coding_edit` 生成可审阅的完整补丁。源码补丁不会绕过界面审批直接写入，批准后仍保留 Git 检查点并支持回滚。

## 首次使用

1. 打开 Pi 面板，Pi 默认以 coding Agent 身份工作。
2. 在“编程环境”条目点击“安装/检查”。应用会探测 Node.js、npm、pnpm、Git、Python，并在 Windows 上优先使用用户级 `winget` 安装缺失的 Node.js LTS、Git 和 Python 3.12。
3. 如果源码工作区有 `pnpm-lock.yaml`，会运行 `pnpm install --frozen-lockfile`；否则运行 `npm install`。存在 `requirements.txt` 时会创建项目内 `.withyou-python` 虚拟环境。
4. `requiresUserAction` 会显示无法自动完成的步骤，例如系统没有 winget 或安装器被策略阻止。应用不会把 API key、token、cookie、密码等环境变量传给编码命令。

## 命令和文件边界

- 工作目录固定为当前源码工作区，禁止访问工作区外路径以及 `.env*`、`.git`、`.data`、`node_modules`、`secrets` 等目录。
- bash 只允许项目开发命令（pnpm/npm/node/python/git/tsc/vitest/next 等），禁止 PowerShell、系统管理命令、网络下载、重定向、管道和破坏性 Git 操作。
- 每个命令有超时、输出上限和进程树终止机制；取消或超时不会留下后台子进程。
- 读写工具使用同一套路径守卫。编辑只生成候选补丁，用户批准前磁盘内容不变。

## 发布注意

Electron 安装包已经包含 Next standalone 运行时和 Pi SDK。系统级 Git/Python 不作为 asar 内容打包，而是在首次使用时由环境管理器探测并按用户选择安装；这样不会覆盖用户已有版本，也不需要把密钥或项目依赖放进安装包。生产安装包需要设置 `PI_SOURCE_WORKSPACE` 指向可维护源码工作区，并保持该工作区为 Git 仓库。
