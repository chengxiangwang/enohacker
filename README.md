EnoHacker
=========

EnoHacker 是一个将 pi-coding-agent 集成到 Visual Studio Code 的扩展。

主要功能
- 在集成终端中启动 pi CLI
- 为集成终端注册 "EnoHacker CLI" 终端配置（Terminal Profile Provider）
- 允许通过配置项指定本地 pi CLI（enohacker.piPath）

安装
- 从 VSIX 文件安装（本仓库已生成 vsix）：
  code --install-extension enohacker-0.0.1.vsix

如何启动 pi terminal（用户指南）

1) 使用命令面板（推荐）
- 打开 Command Palette：
  - macOS: Shift+Cmd+P
  - Windows / Linux: Ctrl+Shift+P
- 输入并运行：Start pi in Terminal
  - 这会创建并打开一个名为 "pi (enohacker)" 的集成终端，并尝试在其中启动 pi CLI（如果已找到）。
- 该命令对应的内部命令 ID 为："enohacker.openPiTerminal"，也可以通过快捷方式或扩展 API 调用该命令。

2) 通过终端配置（Terminal Profile）
- 如果扩展检测到可运行的 pi CLI，会在终端配置中注册名为 "EnoHacker CLI" 的配置项。
- 你可以通过：Terminal -> New Terminal -> 从配置列表中选择 "EnoHacker CLI" 来启动。

常见问题与排查
- 如果没有任何反应或终端未运行 pi：
  - 打开输出面板（View -> Output），在右上角的下拉选择 "EnoHacker" 查看扩展日志，里面会记录查找 CLI、启动过程和错误信息。
  - 确保你的工作区或扩展内包含可执行的 pi CLI：例如路径指向
    - 已打包的 JS: /path/to/.../dist/cli.js
    - 或开发源码: /path/to/.../src/cli.ts（需要 npx tsx 可用）
  - 你可以在设置中手动指定 pi CLI 路径：
    - 设置项：enohacker.piPath
    - 示例（settings.json）:
      "enohacker.piPath": "/Users/you/dev/pi-mono/packages/coding-agent/dist/cli.js"
  - 修改设置后，可能需要重新加载窗口（Command Palette -> Developer: Reload Window）以确保终端配置被正确注册。
  - 当使用 TypeScript 源（.ts）时，终端会通过 npx tsx 启动，请确保你可以从 shell 访问 npx/tsx。

使用说明
- 在 Command Palette 中运行 "Start pi in Terminal" 命令。
- 如果在工作区或全局安装了 pi CLI，并且配置了 enohacker.piPath，扩展会优先使用该路径。
- 你也可以在集成终端的下拉菜单选择 "EnoHacker CLI"（如果已注册）。

配置
- enohacker.piPath (string)
  - 说明：指向本地 pi CLI 的路径（例如 cli.js）。如果设置，扩展会优先使用此路径来启动 pi。支持 ~ 和相对工作区路径。

开发
- 安装依赖并编译（需要 Node.js）：
  npm install
  npm run compile

- 开发时监听源码变更：
  npm run watch

- 打包为 VSIX：
  npm run package

  说明：打包需要 vsce；在本环境我们使用：
  vsce package --allow-missing-repository --allow-star-activation --no-dependencies --follow-symlinks

项目结构（简要）
- src/         TypeScript 源码
- out/         编译后的 JavaScript
- package.json 扩展元数据与脚本

许可证
- 本扩展采用 MIT 许可证（详情见 LICENSE 文件）。

贡献
欢迎提交 issue 或 PR。如需在本地修改并打包，请参考上面的开发与打包部分。
