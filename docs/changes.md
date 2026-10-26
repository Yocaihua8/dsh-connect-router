# 实施与文件范围

独立插件位于 dsh-connect-router，原 OpenCode 工作树保留。上一阶段逐文件 SHA256 留档于 checkpoint-files.json，相应增改留档于 revision-files.json、revision-alpha2-files.json；最新紧凑修订文件及哈希见 revision-alpha3-files.json。清单排除依赖、构建产物、真实 home 和清单自身。

- src/client/：正式原生设置、账号池/额度、平铺上下文、能力/费用、福利、诊断、草稿、原生续写及窄屏样式；无演示目录。
- src/host/service.ts 与 src/index.ts：owner RPC、生命周期、授权/签到/目录/日志和恢复状态。
- src/host/accounts.ts、pool.ts、bindings.ts：账号集合、刷新合并、重复身份合并、分配排序及持久请求绑定。
- src/host/adapter.ts、stream.ts、catalog.ts、model-settings.ts：原生消息、图片序列化、严格终止、能力/费用与逐路线设置。
- src/host/recovery.ts、store.ts、benefits.ts：摘要超限后的保护事务、原子迁移、领取去重和恢复持久化。
- src/host/logs.ts、diagnostics.ts：有界脱敏日志、分页和排查建议。
- src/host/workbuddy/、opencode/：固定源码适配、独立桥接、部分 envelope 文本保留，完整合法工具参数后才提交。
- src/shared/types.ts：账号、模型、设置、日志、诊断和继续请求约定。
- test/：协议、账号、草稿、绑定和宿主恢复用例；最终数量见 release-checks.json。
- scripts/build.mjs、scripts/check-package.mjs、package*.json、tsconfig*.json、cordis.patch.yml：正式构建安装入口，SDK 固定 rc.3。早期提取脚本保留供溯源。
- README、LICENSE、THIRD_PARTY_NOTICES、third-party/、docs/：许可、能力、安装/回滚及真实验收。

插件外改动：根 scripts/plugins.mjs 登记；output/router-ui-prototype-20261026 的已确认交互、说明与证据；Router 专用的隔离验证和交付产物。原型明确扫码、页签顺序、账号池、平铺上下文与排查日志。

早期阶段未安装日常配置；后续日常替换及升级另行验收。历史误构建其他插件的生成文件见 verification.md，未纳入 Router 发布。

## 0.1.0-alpha.2

- 同单位额度合并为单条分色图，未知总量不显示使用百分比，过期包排除，明细按需展开；不改变分配器依据。
- 所有共享选择器换用原生 SVG 箭头。上下文增加 512K / 1M / 实际最大值，自动显示容量；窄屏仅选项区域滚动。
- 日志改为原生弹层按需打开，福利历史折叠。增加公开 Issue 的设备授权、脱敏预览、直接发送、持久回执与只读结果查询；网络中断保留有效的设备等待。
- 构建与包检查从父工程抽出为插件内独立脚本；新增隐私说明、贡献说明及 Issue 模板。
- OpenCode 五个复用模块获得作者明确 MIT 公开许可，保留原始版本、文件哈希和补充许可文本。
- 所有代码修改及文件用途见 revision-alpha2-files.json；测试与实际验收分别记录在 verification.md。

## 0.1.0-alpha.3

- 删除额度明细入口及展开内容，保留额度汇总、分类、单位及未知状态；账号卡显示可用模型数。
- 模型列表隐藏目录标记不可用的条目，删除重复的窗口/最大输出说明。两行紧凑布局保持模型、费用、上下文主行，能力和费用授权在次行。
- 不可用且未修改的模型保留原设置并跳过当前窗口/能力校验；变为不可用前已有草稿修改时，客户端点名提示并允许撤销，后端拒绝该项修改。恢复可用后恢复校验。
- 未改变 RPC 或存储字段；未清除账号、模型选择或费用授权。alpha.2 包保留用于回滚。
