# 第三方来源与修改

## 已复用源码

1. **dingminhua/dsh-connect-workbuddy**，5.11.0，提交 `3b558326a962aa2cfa57ff558b452f7635b447ac`，MIT，Copyright (c) 2026 LaoDing。
   - `src/host/workbuddy/vendor/`：抽取 upstream 的聊天、刷新、目录、额度、签到、福利方法及其依赖；复制 OAuth、context-rescue、promo、queue、native-modality、busy。
   - 源文件哈希与抽取根节点：`third-party/workbuddy-source.json`。完整许可证：`third-party/workbuddy-MIT.txt`。上游适用的转引声明原样保留在 `third-party/workbuddy-notices.md`。
   - 修改：取消信号传播；福利读取失败向外报告；国内活动时间按 UTC+8 解析；限制 OAuth 请求目标；增加取消授权入口；聊天发送 DSH attribution；分块压缩要求宿主提供保护边界、限制每块预算、仅对明确可缩小错误重试。
   - 未采用其 shim 的补发 DONE、账号池、自动换号、提示词扰动、完整 CLI Agent、生图和视频实现。新流解析器与 DSH 适配器在本插件中实现。
   - upstream/auth 文档中对 corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）及 Sliverkiss/workbuddy2api 的来源说明保留；本次未复制 DSML 恢复模块，不引入其解析器。

2. **Yocaihua8/dsh-link-opencode** 本地工作树，HEAD `b5ffd63916bbb86fbadc181e917f9c85052126d1`，package 声明 MIT。
   - 只复制 `backend.js`、`bridge.js`、`protocol.js`、`runtime.js`、`catalog.js` 到 `src/host/opencode/vendor/`。
   - 读取时的 Git 状态、逐文件 SHA256 记录在 `third-party/opencode-source.json`，源 package 保留在 `third-party/opencode-package.json`。原目录及其未提交改动未修改。
   - 原目录没有独立 LICENSE；其 package 的 license 声明原样保留，未编造原作者版权行。2026-10-26 查询上述固定 GitHub 提交的 LICENSE 路径返回 404；本次已补齐作者许可确认，见下方“公开许可确认”及 third-party/opencode-MIT.txt。
   - 修改：禁止原生工具；不复制原应用授权与配置；只允许插件提供的凭据投影；关闭自带 envelope 二次请求；要求明确结束证据；价格缺失不判免费；先建立事件订阅，再发送请求，停止观察到的上游 retry 等待；事件使用有界 UTF-8/SSE 解析，损坏帧向外报告；隔离目录使用绝对路径；不转发原始子进程日志。

## 仅参考、未复制代码

| 项目 | 固定提交 | 许可证 | 用途 |
|---|---|---|---|
| dingminhua/dsh-connect-trae | 59125ad5321babfddad7469bb2ea2b54adb9b624 | MIT | 来源隔离、流解析和设置交互 |
| dingminhua/dsh-connect-qoder | af50cc4395e46675bfcd22b29a4c4a383cf55310 | MIT | 后续 Qoder 协议与模型/用量/活动 |
| eghrhegpe/dsh-connect-qoder | 1e4e250d3ba3511a2b5080d3ff95c55a35399960 | MIT | 后续设备授权、生命周期、流尾测试 |

参考不代表已接入或已验收。两个 Qoder 仓库分别记录，不互相替代。

## 正式实现追加修改 · 2026-10-26

- WorkBuddy 全目录与费用字段按上游声明读取，模型路线带区域；凭据与来源账号集合由本插件管理，不复用上游账号轮换。
- context-rescue 的保护范围允许异步读取宿主真实会话投影，所有压缩通过 DSH 事务并贯穿取消。
- OpenCode 协议增加有界根 content 字段增量解码，断流仍保留已解码正文；工具参数不从部分 envelope 执行。关闭自带二次请求和 Agent 原生工具。
- 上游实际通道拒绝直接记录，不移植系统头替换或不可见扰动逻辑。
- alpha.2 vendor 基线哈希见 third-party/source-modifications-20261026.json；alpha.4 修改哈希见 third-party/router-alpha4-source.json。来源原始哈希保留在此前的 source receipts。

## 原型素材

原型位于 `../output/router-ui-prototype-20261026`，复用本地 `@deepseek-ai/dsh-client-ui-primitives` 0.2.1-rc.3 的控件、字体样式和图标，其 LICENSE 与 provenance 随原型 `src/native/` 保留。原型不进入正式插件包。

## 公开许可确认 · 2026-10-26

Yocaihua8 在本次交付中明确确认，原 dsh-link-opencode 的 backend.js、bridge.js、protocol.js、runtime.js、catalog.js 可按 MIT 随新插件公开并保留来源。对应许可文本见 third-party/opencode-MIT.txt。此为本次授权补充，不声称固定历史提交中存在 LICENSE；原工作树未修改。

正式界面修订仅汇总展示独立额度包，不修改后端分配数据；上下文使用实测目录 maxInputTokens/maxOutputTokens，不增加推测的容量。

## alpha.4 成熟目录方案复用

- 新增 vendor/catalog-sync.ts：从相同固定提交 src/catalog-sync.ts 抽取 LIVE_OWNED_FIELDS、overlayLiveCapabilities、mergeRoster，保留版权注释。来源哈希及当前适配哈希见 third-party/router-alpha4-source.json；scripts/vendor-catalog-sync.mjs 可复现抽取。
- 接回已抽取的 selectCliModels、fetchModels CN v3→v2 回落和 keepIds；目录/sync 用例迁移到 test/workbuddy-roster.test.ts。失效名单、禁用与移除条目仅保留诊断。
- Router 适配层让实时窗口、价格、可用性优先；完整目录明确删除的缓存行标记 MODEL_REMOVED。目录网络失败允许最近本机缓存，不把普通超时/通道拒绝当永久下架；401/403 拒绝缓存回落。
- 使用 vendor/promo.ts 的 selectPromoMultiplier 按当前时间计算明确促销价，活动结束不继续标免费。账号分配继续由 Router 控制，额度耗尽不隐式转付费，不复用中途换号重试。
- 同名分组、稳定组配置、线路绑定、费用授权和 UI 由 Router 实现，未复制原插件 UI。
