# API 服务

## 适用范围

适用于 services/api，继承 [根约定](../../AGENTS.md)。services 下其余 README 目录不代表已有运行服务。

## 修改前与边界

从 [开发指南索引](../../docs/development/README.md) 只选本次身份、授权、审批或组织指南；触及持久化继续读 [数据库约定](../../packages/db/AGENTS.md)。

Fastify 路由只做输入/上下文与用例衔接。HTTP、工具、WebSocket 不能分别发明权限规则。租户来自可信会话/授权上下文，不信任客户端 organization_id。事务中按现有边界重新鉴权，拒绝/取消不能提交部分成功。

默认本机开发不读取身份凭据、不自动迁移。`/livez` 只表示进程存活，`/readyz` 的 503 不得改成伪就绪。日志不暴露原始错误、凭据或业务正文。

## 验证

运行 `pnpm check` 和对应真实 PG/HTTP/WS 集成；UI 消费改变另测浏览器。新增拒绝、撤权、租户隔离与取消用例。不要把成功路径单测当成鉴权验收；见 [验证路由](../../docs/harness/verification.md)。
