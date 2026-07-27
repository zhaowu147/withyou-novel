/**
 * 本地模式说明
 *
 * ── 数据根解析 ──────────────────────────────────────────────
 * 唯一入口: src/lib/runtime/app-paths.ts。禁止在别处用 process.cwd() 拼数据路径：
 * 打包成 exe 由用户双击启动时 cwd 不可预测（可能是 System32、桌面，或快捷方式里的
 * "起始位置"），数据会随启动方式漂移，用户看到的现象是"我的小说全没了"。
 *
 * 解析顺序（先命中者胜，结果缓存）：
 *   1. WITHYOU_DATA_DIR              显式指定 —— 打包启动器应当设置它
 *   2. 从 process.cwd() 向上找仓库锚点  开发时的行为，与历史一致
 *   3. 从 argv[1] / __dirname 向上找   cwd 不对时仍能定位到仓库
 *   4. 操作系统用户数据目录             打包运行且未设 env 时的兜底
 *        Windows  %APPDATA%\withyou-novel
 *        macOS    ~/Library/Application Support/withyou-novel
 *        Linux    ${XDG_DATA_HOME:-~/.local/share}/withyou-novel
 *
 * 仓库锚点 = 同时具备 package.json(name=withyou-novel) 与 src/ 目录。
 * next build --standalone 的产物没有 src/，因此不会被误判成仓库、
 * 不会把用户数据写进程序目录。
 *
 * 若选中的根还没有数据、而另一个候选目录里有，启动时会 console.warn 指出
 * 数据可能在哪 —— 这是"小说不见了"最常见的成因。
 *
 * 数据根下的布局：
 *   novels/          小说数据（可用 NOVELS_BASE_DIR 单独覆盖）
 *   .data/           运行时状态：workspace-bindings.json、recovery/、
 *                    pi-sessions/、pi-source-sessions/、pi-agent/
 *   settings.json    模型与 API Key 配置（含三代 .bak）
 *
 * 打包交付时请把数据根指到用户目录（例如 %APPDATA%\withyou-novel），
 * 不要留在程序安装目录 —— 否则卸载或覆盖升级会连用户作品一起删掉。
 *
 * ── 每本小说的目录结构 ──────────────────────────────────────
 * novels/<书名>/
 *   设定/ 大纲/ 正文/ 追踪/ 对标/     # 文本工作区（novel-fs）
 *   prompts/                          # 提示词包
 *   vault/
 *     meta.json
 *     entities.json
 *     foreshadows.json
 *     timeline.json
 *     snapshots.json
 *     chapter_files.json
 *     graph.json                      # 知识图谱（含三代 .bak）
 *     .index/                         # SQLite FTS5 记忆索引，可重建
 *
 * 登录: 固定 local-user，无需远端账号
 * LLM: settings.json 优先，其次 .env.local 里的 Key
 * 云库: 已禁用；createClient 为 stub
 *
 * 相关测试: tests/app-paths.test.ts（pnpm test:paths）
 */
