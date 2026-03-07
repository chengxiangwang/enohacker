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

使用说明
- 在 Command Palette（Shift+Cmd+P / Shift+Ctrl+P）中运行 "Start pi in Terminal" 命令。
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
