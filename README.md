# EnoHacker

EnoHacker 是一个模仿 Copilot 工作流的 VS Code 扩展 MVP：

- 在侧边栏提供聊天面板（Explorer > EnoHacker Chat）
- 输入问题后返回代码建议
- 支持把最新建议一键插入当前编辑器
- 支持从当前选中代码发起提问

## Features

### 1) Chat View

打开 `EnoHacker Chat` 视图，输入你想问的问题（如“帮我重构这段代码”）。

输入框下方提供模型列表，可快速切换当前模型。

`Manage Models` 按钮可打开模型管理页面。

在管理页面输入自定义模型并保存后，会持久化到 `enohacker.customModels`，下次仍会出现在模型列表中。

### 2) Ask From Selection

命令：`EnoHacker: Ask From Selection`

流程：

1. 在编辑器中选中一段代码（可选）
2. 运行命令
3. 输入问题
4. 结果回到聊天面板

### 3) Insert Last Suggestion

命令：`EnoHacker: Insert Last Suggestion`

会把最近一次回答插入到当前光标处，若有选区则替换选区。

### 4) Provider Status Bar

状态栏右侧会显示当前 provider 与连通状态：

- `?`：未检测
- `spinner`：检测中
- `check`：连通正常
- `error`：连通失败

点击状态栏会触发 `EnoHacker: Check Provider Connection`。

## Commands

- `EnoHacker: Open Chat`
- `EnoHacker: Ask From Selection`
- `EnoHacker: Insert Last Suggestion`
- `EnoHacker: Check Provider Connection`
	- 按当前 `enohacker.provider` 检查连通性并提示错误详情
- `EnoHacker: Configure Model`
	- 交互式配置 provider、model、baseUrl、apiKey、temperature，并可立即连通性检测
- `EnoHacker: Open Model Manager`
	- 打开模型管理页面，统一管理 provider 与模型参数

## Settings

- `enohacker.systemPrompt`
	- 语言模型可用时的系统提示词
- `enohacker.maxResponseLines`
	- 插入编辑器前对响应行数做截断
- `enohacker.provider`
	- 模型提供商：`openai` / `anthropic` / `ollama`
- `enohacker.model`
	- 模型名（按 provider 使用）
- `enohacker.baseUrl`
	- 可选接口地址覆盖（默认走官方地址或 Ollama 本地地址）
- `enohacker.apiKey`
	- OpenAI/Anthropic 的 key（建议优先使用环境变量 `ENOHACKER_API_KEY`）
- `enohacker.temperature`
	- 采样温度
- `enohacker.enableDebugLogs`
	- 打开后会在 Output > EnoHacker 输出每次 Ask 的实际 provider/model/baseUrl，便于排查模型路由问题

### 配置示例

OpenAI:

```json
{
	"enohacker.provider": "openai",
	"enohacker.model": "gpt-4o-mini",
	"enohacker.temperature": 0.2
}
```

Anthropic:

```json
{
	"enohacker.provider": "anthropic",
	"enohacker.model": "claude-3-5-sonnet-latest"
}
```

Ollama:

```json
{
	"enohacker.provider": "ollama",
	"enohacker.model": "qwen2.5-coder:7b",
	"enohacker.baseUrl": "http://localhost:11434/api/chat"
}
```

## Notes

- 支持 OpenAI / Anthropic / Ollama 三种 provider
- 若模型 API 不可用，会自动退化为本地 fallback 建议，保证流程可用

## 快速配置大模型

1. 在命令面板运行 `EnoHacker: Configure Model`
2. 选择配置写入位置（User / Workspace）
3. 选择 provider 并填写模型参数
4. 选择是否立刻执行连通性检测
