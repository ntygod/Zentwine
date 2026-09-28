# 本地基础设施

## 适用范围

继承 [根约定](../AGENTS.md)。先读 [统一环境指南](../docs/development/local-environment.md)。当前资源用于本机合成测试，不代表生产部署。

显式启动独立临时服务，限制端口与生命周期；迁移身份和运行身份分离。不得把生产数据/凭据放入 Fixture，不暴露 Docker socket 给不可信插件。

清理只作用于本次创建的资源，取消与故障后核对残留。SIGKILL/宿主异常恢复不能靠普通 finally 代替；按现有 recovery 测试验证。

运行 `pnpm doctor`、对应 `pnpm drill --suite database` 或 `pnpm drill --suite durability`；工具准备、Docker 权限与外网下载须明确记录。缺服务就报告缺失，不以仅解析 YAML 宣称演练通过。
