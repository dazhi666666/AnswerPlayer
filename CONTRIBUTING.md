# 参与 AnswerPlayer 开发

感谢你愿意参与改进 AnswerPlayer。这个仓库面向桌面客户端的社区开发，不包含生产授权服务及其部署资料。

## 开始开发

1. 安装当前 Node.js LTS 版本与 npm。
2. 运行 `npm install` 安装依赖。
3. 按 `.env.example` 在本机 shell 中设置所需环境变量。
4. 运行 `npm start` 启动应用。

## 提交变更

- 一个 Pull Request 尽量只解决一个清晰的问题。
- 保持现有原生 HTML、CSS、JavaScript 与 Electron IPC 的代码风格。
- 修改界面行为时同步补充或调整 `tests/` 中的覆盖。
- 提交前运行 `npm test`。
- 不要提交 `node_modules/`、日志、测试结果、用户数据或本地编辑器配置。
- 不要提交 API 密钥、访问令牌、激活码、个人信息或任何其他凭据。
- 不要提交私有服务端代码、数据库、部署配置或运维文档。

## 报告问题

请提供操作系统、Node.js 版本、Electron 版本、复现步骤、期望行为和实际行为。日志与截图中如含面试内容、密钥或个人信息，请先完成脱敏。

安全问题请不要公开披露，处理方式见 `SECURITY.md`。
