EnoHacker - VS Code sidebar wrapping pi-coding-agent

这是一个最小示例扩展，展示如何在 VS Code 侧栏中包装 pi-coding-agent（以 RPC 模式运行 pi CLI），实现类似 CLI 的交互体验。

文件说明（已创建）：
- package.json — 扩展 manifest
- tsconfig.json — TypeScript 配置
- src/extension.ts — 扩展主入口（注册 WebviewViewProvider，启动 pi RPC 子进程）
- media/sidebar.html, sidebar.js, sidebar.css — 侧栏 Webview 前端静态文件

快速开始：
1. 在扩展目录安装依赖（会使用工作区内的 local pi 包）：

   cd /path/to/enohacker
   npm install

   如果你想使用 npm 上的包而不是本地副本，请修改 package.json 中的依赖并运行 npm install。

2. 编译 TypeScript：

   npm run compile

3. 在 VS Code 中按 F5 启动 Extension Development Host。侧栏会出现 "EnoHacker" 图标，打开后即可输入 prompt 并发送给 pi。

注意和建议：
- pi CLI 要求 Node >= 20.6.0（请确保 PATH 中的 node 满足要求）。当前实现通过 spawn('node', ...) 启动 pi。若系统 node 版本过旧，请用配置或绝对路径指向合适的 node 可执行文件。
- 我采用了 RPC 模式（pi --mode rpc）以避免在扩展宿主中直接加载 pi 的 ESM 包。这样更稳健但需要可用的 pi CLI（dist/cli.js）。
- 默认路径指向工作区上的 ../pi-mono/packages/coding-agent/dist/cli.js；若你通过 npm 安装了 @mariozechner/pi-coding-agent，请把 cliPath 改为相应位置或直接安装到 extension 的 node_modules。
- 身份认证/API key：pi 使用环境变量或 ~/.pi/agent/auth.json 来保存 API keys（或通过 /login）。RPC 子进程继承启动时的环境变量，建议在系统中设置 ANTHROPIC_API_KEY/OPENAI_API_KEY 等，或先在终端运行 pi 并完成登录。

后续工作（功能建议）：
- 支持模型/提供商选择（在扩展侧提供 UI，向 pi 发送 /model 命令或在子进程中更改 auth）。
- 将富文本输出（代码块、工具输出）格式化在 Webview 中；提供 "折叠/展开"。参考 pi RPC 消息结构处理 tool_execution_* 事件。
- 支持文件引用（@ 文件名）和路径自动补全：在扩展中实现文件列表并传给 webview，或通过 pi 的 read 工具交互。
- 持久化会话/历史：可以让 pi 使用 sessions（去掉 --no-session）并实现 resume/compact/branch UI。

如果你希望，我可以：
- 把扩展改为直接在宿主内使用 SDK（createAgentSession），或
- 为侧栏实现更完整的前端（带文件选择、可配置工具集、模型切换），或
- 运行 npm install/编译并在本机调试一次并把结果告诉你。

告诉我你想先做哪一步，我可以继续帮你迭代。