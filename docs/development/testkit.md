# ZT01-04｜隔离测试开发指南

本轮新增的是测试基础，不是可用的真实模型、业务身份或生产 Runner。所有 Fixture 都是合成数据；不要粘贴真实模型 Key 或生产数据库 URL。

## 单元、API 与 FakeRuntime

沿用 Node 24.21.0、pnpm 11.10.0：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:fixtures
```

`pnpm test` 包含既有核心/API及新增 Fixture 测试，不连接数据库。每个测试文件独立进程，测试内部按需要使用 Promise.all；不存在共享 FakeRuntime 单例。

```ts
import { createTenantFixtures, FakeRuntime, fakeRequest } from '@zentwine/testkit';
const [tenant] = createTenantFixtures('my_test');
const runtime = new FakeRuntime(tenant);
const request = fakeRequest(tenant, 'fixture_run_1');
runtime.start(request, [{ type: 'wait' }, { type: 'succeed' }]);
runtime.advance(tenant.org_id, request.run_id);
runtime.sendInput(tenant.org_id, request.run_id, 'fixture_input_1', tenant.context_snapshot_id, 'continue');
runtime.advance(tenant.org_id, request.run_id);
```

只读 observe/events 不开始执行；start 相同输入复用，改变模型或脚本冲突。artifact/wait/fail/unknown/succeed 是固定脚本，不执行命令。requestStop 只到 stop_requested，acknowledgeStop 才取消；终态不重写。setConnected(false) 使传输不可访问，测试控制器仍可推进“远端”；恢复后从 events(after) 取未读记录。transport 可注入重复、丢失与逆序，不改变源历史。没有后台定时器或收费调用。

每实例最多128个Run、每Run最多256步骤；事件和结果冻结、总是fixture_only。不同测试用不同scope；相同scope有意产生相同可重现内容，不保证跨进程全局唯一。不同租户即使使用同名run，事件ID也不同。

这些事件使用fixture.v1，不可直接当作正式RuntimeEvent。未来ZT12需要补全正式协议、适配一致性与live能力验证。

## 浏览器

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

两个Worker并行，每例独立上下文，保留既有7场景并新增存储/路由隔离用例。仅允许本机三个服务来源的网络请求；这是测试护栏，不是生产安全边界。测试启动真实API和构建页面，不使用生成图片作为执行证据。

## 真实临时PostgreSQL

提供 `infra/testkit/compose.yml`：数据库端口仅绑定127.0.0.1，数据在临时文件系统中，入口初始化固定标记。使用已安装的Docker Compose：

```bash
docker compose -f infra/testkit/compose.yml up -d --wait
export ZENTWINE_TEST_DATABASE_URL='postgres://zt_test_admin:zt_fixture_password_only@127.0.0.1:55432/zentwine_test_control'
export ZENTWINE_TEST_DATABASE_ACK='disposable-local-only'
pnpm test:integration
docker compose -f infra/testkit/compose.yml down --volumes
```

最后一条只清理本项目的测试服务，不对任意数据库执行删除。测试失败或被中断也应执行down。此Compose文件的端到端启动如未经CI执行，会在报告中如实列出；CI使用相同镜像和bootstrap SQL的独立service container。

集成命令先过滤子进程环境，不继承模型Key、DATABASE_URL、PGHOST、NODE_OPTIONS或代理变量。它可在development或未指定NODE_ENV时显式启动test子进程；production模式拒绝。缺URL/ACK时退出1，而不是把测试标为通过。

withTestDatabase(env, connector, tenants, callback)为每个回调创建新的随机数据库和最小权限角色。transaction(tenant, callback)使用单个连接、BEGIN和事务局部租户上下文，自动COMMIT/ROLLBACK并关闭。测试表名fixture_rows，复合键org_id/id，固定fixture_only=true，启用RLS。不要在普通回调里自行COMMIT、关闭连接、启动未等待的后台事务或修改租户setting；其中专门的异常用例仅用于验证边界。

dispose可重复调用，忙时明确失败；清理异常必须处理而非忽略。回调失败且清理失败时保留二者。只删除自身创建的名字/OID，不扫描清除其他suite。资源名以zt_test_或zt_role_开头，检查应针对当前suite记录的精确名单。

## 安全与范围

辅助库SQL端口不自动认证租户；Fixture权限表不替代ZT02。实际RLS测试说明该测试表的过滤和写入限制成立，不能证明尚未实现的生产业务接口安全。临时目录不是执行沙箱；网络Mock不是不可绕过的系统级拦截。

通过Fake不等于Claude/Codex接通。`pnpm check`不包含显式数据库集成，完整门禁还需test:integration及test:e2e。诊断日志、数据库结果和截图都是合成环境，不上传真实凭据。未来ZT01-05再整合完整工程门禁及live跳过规则。
