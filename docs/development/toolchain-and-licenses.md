# 工具版本与许可记录

核对日期：2026-09-24。精确控制值在 `infra/development/toolchain.json`、根 `package.json`/`pnpm-lock.yaml` 和隔离 Spike 的 `package-lock.json`。本工作包不升级已有JS依赖。

| 组件 | 固定或支持范围 | 许可/来源记录 |
|---|---|---|
| Node.js | 24.21.0，Linux x64已测试 | Node发行包LICENSE，含MIT及捆绑组件声明 |
| pnpm | 11.10.0 | MIT；包的LICENSE与安装清单 |
| TypeScript | 主工程6.0.2，Spike5.9.3 | Apache-2.0；两套锁分别保存 |
| React / react-dom | 19.3.0 | MIT；主工程锁及CI许可元数据 |
| Vite / React插件 | 8.3.0 / 6.1.1 | MIT；主工程锁及CI许可元数据 |
| Fastify / pg | 5.12.5 / 8.16.3 | MIT；pg仅测试与隔离Spike使用 |
| Playwright | 1.63.0，配套Chromium | Apache-2.0；浏览器还含独立第三方声明 |
| Prettier / Oxlint | 3.6.2 / 1.81.0 | MIT；包与捆绑内容需保留各自声明 |
| Temporal TS SDK / CLI | 1.24.0 / 1.9.1 | MIT；官方发行仓库与实际包声明 |
| PostgreSQL | 17.11，镜像摘要固定 | PostgreSQL License及镜像系统组件声明 |
| Docker Engine / Compose | 本机Unix socket，Compose≥2.20；CI记录实测版本 | Engine/Compose源码Apache-2.0；不将Docker Desktop商业条款与其混同 |
| Python验证工具 | `quality/requirements.txt`固定顶层版本 | jsonschema/PyYAML为MIT；CI记录pip freeze，传递依赖未全哈希冻结 |
| flock / curl / tar | Linux系统工具，CI记录发行版本 | 以util-linux/curl/GNU tar发行包各自LICENSE为准；不随源码包捆绑这些二进制 |

每次CI已有的 `dependency-licenses.json` 与实际依赖清单，是该次构建的详细JS许可证元数据。列表是工程归档，不是法律审查或再分发授权；正式打包桌面/容器发行时还要复核系统库和浏览器内容。产品本身继续为 private / UNLICENSED，不改变用户的发行决定。

## 不变性与环境范围

PostgreSQL镜像和CLI归档的完整摘要位于机器清单；本地CLI每次使用前对比已验证归档内字节，依赖安装使用冻结锁。镜像摘要只证明拉取目标一致，不证明永久没有漏洞；既有CI仍审计当次告警。

Linux x64是本工作包实测范围。macOS、Windows、ARM64及离线企业镜像需要额外验证；不能只因为命令看起来跨平台就宣称支持。Compose/Engine系统工具不强行替换用户安装，而检查最低能力并把实测版本写入CI报告。

## 官方资料入口

- [Node支持版本和许可](https://nodejs.org/en/about/previous-releases)
- [Docker Compose up --wait](https://docs.docker.com/reference/cli/docker/compose/up/)
- [Docker Compose down的删除范围](https://docs.docker.com/reference/cli/docker/compose/down/)
- [Docker context与DOCKER_HOST](https://docs.docker.com/engine/manage-resources/contexts/)
- [Temporal CLI固定发行](https://github.com/temporalio/cli/releases/tag/v1.9.1)
- [Temporal TypeScript SDK固定发行](https://github.com/temporalio/sdk-typescript/releases/tag/v1.24.0)
- [PostgreSQL License](https://www.postgresql.org/about/licence/)
