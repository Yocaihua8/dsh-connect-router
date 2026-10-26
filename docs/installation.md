# 安装与回滚

适用 DSH 0.2.1-rc.3、Node >=22.19，OpenCode 来源需本机已安装 OpenCode。当前为 alpha 候选；真实账号与原生压缩验收边界见 verification.md。

## 独立验证

先将 `DSH_HOME` 指向新目录，创建独立 web profile，安装本插件包。不要复制日常账号凭据或厂商应用目录。进入设置 → Connect Router。

- WorkBuddy：模型来源 → 扫码添加账号；在官方页面完成授权。授权后按账号触发每日签到。
- OpenCode：匿名公共来源自动出现。Zen / Go 在添加账号中输入官方 API Key。额度接口缺失时显示未知。
- 点击刷新目录，在模型主行勾选模型、选择上下文。列表只显示可用条目；不可用条目的已保存配置仍保留。保存后出现在 DSH 原生模型选择器。新模型不自动启用。
- 费用策略默认仅允许免费与已知赠送/套餐额度；付费与未知路线需逐模型显式选择。
- 统一测试检查授权和目录连接，不代表对话、工具或媒体能力通过。
- 连接与恢复 → 查看日志按需打开原生面板。福利历史默认收起。日志默认保留 7 天、最多 10,000 条；导出单页最多 500 条，诊断包包含 nextCursor。领取去重记录独立保存。
- 同轮绑定独立持久化，最多 10,000 条绑定键（包含请求及最近请求索引）；达到上限时明确停止新分配，不静默淘汰仍可能恢复的绑定。清理前须确认旧会话不再需要恢复并备份。
- 这是本机 alpha 验证包。上游通道拒绝、未接入媒体、目标 SDK 的 Zod 公告详见 remaining.md，不建议此时替换日常模型路线。

## 日常安装

退出日常 DSH 后，先备份日常 `DSH_HOME` 内的 profile 配置、插件依赖 manifest/lockfile、原插件包与 `plugins/dsh-connect-router` 数据目录。凭据存储按 DSH 原生方式备份，备份不得公开。执行 `dsh plugin --profile <日常 profile> add <安装包绝对路径>`；保留旧包和版本号。重新启动后核对账号、模型与工具权限。

## 回滚

退出 DSH，使用相同 profile 的 plugin remove 移除 dsh-connect-router，或安装备份的旧包；恢复对应 profile 的 manifest、lockfile、配置和插件数据备份，再启动。不要覆盖其他插件的当前配置或厂商应用登录文件。仅需停用时先在 DSH 中禁用插件；移除账号会删除其 DSH 凭据，操作前确认是否需要保留。

日常 desktop profile 已使用本插件替换 link-opencode；原源码、旧数据与 alpha.2 包均已保留。后续升级应先在 5190 隔离环境检查，再备份日常配置、凭据及 Router 数据，通过官方 CLI 安装新包。回滚到 alpha.2 只更换包版本，保留当前账号和设置，不用旧整份凭据覆盖后续授权。各版本实际安装状态见 verification.md。

## GitHub 问题反馈

连接与恢复 → 反馈问题（或日志面板内的反馈入口）。连接 GitHub 后，在官方设备页面输入插件显示的代码并授权。编辑标题和描述，生成预览，检查目标公开仓库与诊断，再点“确认发送”。当前筛选下最多最近 50 条日志，正文 48 KiB；超时显示待核对，应查询结果，不要重新生成相同问题绕过去重。未登录也可本地导出诊断。

GitHub App：Yocaihua8 Connect Router Feedback，公开 Client ID Iv23lizL3FgdbhfrtQYQ。App 安装范围仅 Yocaihua8/dsh-connect-router，Issues 读写、元数据只读；不保存 App Secret 或私钥。关闭本地连接与 GitHub 撤销授权的区别见 PRIVACY.md。
