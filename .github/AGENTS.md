# CI 工作流

## 适用范围

继承 [根约定](../AGENTS.md)。先读 [质量门禁](../docs/development/quality-gates.md)，以 [可执行策略](../scripts/quality/gate.py) 为准。

所有工作流只用 contents: read，action 固定提交；不引入 pull_request_target、secret 继承、凭据持久化、write 权限或 continue-on-error。分支维护不能借 CI 获得删除权。

保留 quality 的全部必需 job 与命令；取消、跳过、缺失均不可算通过。新增 harness 验证接入原 documentation job，不用另一个非必需绿灯替代总门禁。

验证制品绑定精确提交、suite 和真实状态；always 上传失败诊断不等于通过。构建后核对 tracked source 不变。

运行 `python3 scripts/quality/gate.py workflows`、`pnpm test:quality`；最终以该 head 的完整 CI 回读为准。此仓库配置不等于平台已安装强制分支保护。
