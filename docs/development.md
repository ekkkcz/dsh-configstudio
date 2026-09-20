# 开发与验证

改了 `web/app.js` 或 `src/` 之后，**整套重跑**（全部零费用）：

```powershell
# 1) 单元与集成测试（模拟模型，零费用）
node --test "tests/**/*.test.js"

# 2) 全部验收脚本一次跑齐（会自己判断依赖的服务在不在）
node scripts/m4-full-regression.mjs
```

`m4-full-regression.mjs` 会逐条打印每个套件的结果，最后明确列出
**"哪些 A 编号没有被任何套件覆盖"**。它每跑完一条就把进度写进
`docs/evidence/m4-full-regression-live.json`，中途被打断也能看到跑到哪了。

需要先起服务（请在独立终端中保持运行）：

```powershell
node scripts/dev-server.mjs --port 8790          # 模拟模型，零费用
dsh --profile <测试用 profile> --port 8902 --no-open
```

**升级/卸载/干净安装**这套单独跑（会自建临时 profile，不碰你现有的）：

```powershell
node scripts/m4-upgrade-uninstall-check.mjs
node scripts/m4-clean-install-check.mjs --base http://127.0.0.1:<干净实例端口>
```

---

升级 DSH 后可运行只读接口检查：

```powershell
node scripts/dsh-contract-check.mjs
```

[返回项目首页](../README.md) · [架构说明](architecture.md) · [验收记录](acceptance.md)
