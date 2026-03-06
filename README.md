# Enohacker AI - VS Code Extension

这是一个基础的 VS Code 扩展模板，名称为 `enohacker-ai`。后续可以在此基础上添加 AI 功能、命令、WebView、语言服务等。

快速开始

1. 安装依赖：

   npm install

2. 编译：

   npm run compile

3. 在 VS Code 中调试：

   - 打开本工程，按 F5 启动 Extension Development Host

4. 运行命令：

   打开命令面板（Ctrl/Cmd+Shift+P），执行 `Enohacker AI: Start`。

项目结构

- src/extension.ts - 扩展入口（activate / deactivate）
- package.json - 扩展清单（manifest）
- tsconfig.json - TypeScript 配置

后续建议

- 修改 package.json 中的 `publisher` 字段为你的发布者 ID
- 按需添加 WebView、安全策略、SecretStorage、Workspace Trust 判断
- 编写单元与集成测试并在 CI 中运行

如果你希望我在该项目中加入具体功能（例如：调用 OpenAI、聊天面板、代码补全、命令行助手等），告诉我需求和授权（API Key 存储策略），我可以继续实现。
