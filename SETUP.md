# CimiClaw 快速启动指南

## 1. 环境要求

| 项 | 要求 |
|---|---|
| **Node.js** | >= 22.16.0 |
| **包管理器** | pnpm@11.0.8（通过 Corepack） |

## 2. 安装依赖

```bash
pnpm install
```

## 3. 配置 API Key

```bash
cp .env.example .env
```

编辑 `.env`，取消注释并填入至少一个模型 API Key：

```
ZAI_API_KEY=你的智谱API Key
```

## 4. 配置默认模型

`pnpm dev gateway` 已默认配置 `zai/glm-5.1` 模型，通常无需手动设置。

如需自定义，编辑 `~/.openclaw/openclaw.json`，在 `agents.defaults` 下添加：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "zai/glm-5.1"
      }
    }
  }
}
```

## 5. 启动服务

需要启动两个服务：Gateway（后端）和 UI 开发服务器（前端热更新）。

### 5.1 启动 Gateway

```bash
pnpm dev gateway
```

首次启动会自动构建 TypeScript（约 3-5 分钟），后续启动仅增量构建。
启动后默认使用 `ocean` 主题（深蓝色调）。

启动成功后看到：

```
[gateway] agent model: zai/glm-5.1
[gateway] http server listening
[gateway] ready
```

### 5.2 启动 UI 开发服务器

```bash
pnpm ui:dev
```

启动 Vite 开发服务器，支持前端热更新（修改 UI 代码后浏览器自动刷新）。

### 5.3 非回环地址启动（可选）

默认 Gateway 仅绑定回环地址（`127.0.0.1`）。如需绑定到局域网或其他地址，需设置认证 Token，或通过环境变量跳过认证：

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 pnpm dev gateway -- --bind 0.0.0.0
```

> **注意**：`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` 仅建议用于受信任的私有网络测试环境。

## 6. 访问页面

两个入口均可使用：

| 入口 | 地址 | 说明 |
|---|---|---|
| **UI 开发服务器** | http://localhost:5173/ | Vite 热更新，推荐开发时使用 |
| **Gateway 内置 UI** | http://127.0.0.1:18789/ | Gateway 自带静态 UI（需先 `pnpm ui:build`） |
| **健康检查** | http://127.0.0.1:18789/healthz | Gateway 健康状态 |

首次访问会显示登录页面（CimiClaw 品牌）。由于已配置免认证（`auth.mode: none`），直接点击 **Connect** 按钮即可进入聊天界面，无需填写 Token。

### 内嵌模式（Embed Mode）

CimiClaw 支持通过 iframe 嵌入聊天界面。在 URL 中添加 `?embed=1` 参数即可启用内嵌模式：

```
http://127.0.0.1:18789/?embed=1
```

内嵌模式下：
- 隐藏顶部导航栏和侧边栏，仅显示聊天区域
- 左侧显示会话历史和定时任务面板，支持搜索和折叠
- 支持通过 `postMessage` 进行页面间导航控制

父页面可通过 `postMessage` 发送导航指令：

```javascript
iframe.contentWindow.postMessage({
  type: 'openclaw:navigate',
  tab: 'chat',
  sessionKey: 'session-key-here'
}, '*');
```

## 7. 常用命令

```bash
pnpm dev gateway          # 启动 Gateway 后端（含 TypeScript 构建）
pnpm ui:dev               # 启动 UI 开发服务器（Vite 热更新，端口 5173）
pnpm ui:build             # 构建生产 UI（写入 dist/control-ui，Gateway 18789 端口使用）
pnpm gateway:dev          # 跳过渠道的快速开发模式
pnpm test                 # 运行测试
pnpm check                # 代码检查
pnpm format               # 格式化
```

## 8. 重启 Gateway

在终端中按 `Ctrl+C` 停止当前运行的 Gateway，然后重新启动：

```bash
pnpm dev gateway
```

如果只需要重启而不重新构建全部 TypeScript，可以使用跳过渠道的快速模式：

```bash
pnpm gateway:dev
```

启动成功标志：

```
[gateway] agent model: zai/glm-5.1
[gateway] http server listening
[gateway] ready
```
