# Contributing

感谢参与 AgentDeck。

## 提交 Issue

请尽量提供：

- Windows 版本与 AgentDeck 版本
- 相关 Agent 的名称和版本
- 问题发生步骤与预期结果
- 脱敏后的错误信息或截图

请不要上传完整会话、API Key、访问令牌、用户名路径或其他个人数据。

## 提交 Pull Request

1. 从最新的 `main` 创建分支。
2. 保持改动聚焦，说明动机、行为和兼容性影响。
3. 涉及采集或状态机时，优先补充可复现的脱敏测试数据。
4. 提交前运行：

```powershell
npm test
npm run typecheck
node --check desktop\renderer.js
```

5. 不要提交 `node_modules`、构建目录、本地数据库、日志或真实用户会话。

Windows 客户端数据格式可能随版本变化。修复兼容性问题时，请说明测试过的客户端版本和未覆盖边界。
