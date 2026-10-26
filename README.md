# dsh-connect-router

Connect Router 是面向本机个人使用的独立 DSH 插件，连接 WorkBuddy、OpenCode 匿名公共来源及 Zen / Go。目标宿主 DSH 0.2.1-rc.3。

**当前为 0.1.0-alpha.3 紧凑界面版，完整真实调用验收未通过。** WorkBuddy 官方扫码、目录、额度及自动签到成功；此前聊天被上游通道校验拒绝，OpenCode 免费调用也被上游拒绝。界面和安装验收不代表上游聊天已通过。

## 使用

设置 → Connect Router，三页顺序为“签到与福利 / 模型来源 / 连接与恢复”。

- WorkBuddy 点击“扫码添加账号”，在官方网页完成登录。OpenCode Zen / Go 使用官方 API Key，匿名来源自动建立。凭据由 DSH 管理，不读取原厂应用登录文件。
- 账号池显示脱敏身份、状态、可用模型数量和同单位分色额度汇总。统一测试检查授权与目录连接，不代表模型对话通过。
- 刷新目录后自行勾选模型。上下文档位平铺，自动采用已知模型上限，增加 512K、1M 与实际最大值档位，K=1,000、M=1,000,000 tokens；自定义 4,096 至上限。未知上限禁止手动设置；本地预算不能扩展厂商窗口。
- 能力来自具体路线；支持的可选能力默认开启，关闭影响发布及实际请求。当前实现文本、推理、工具和图片输入；原生图片/音频/视频输出及其他输入尚未接入，不以 Agent 独立工具替代。
- 模型设置切页、切来源保留草稿，保存生效，撤销恢复。列表隐藏不可用条目，已保存配置保留；已有草稿的模型变为不可用时点名提示并阻止保存，可撤销恢复。刷新、授权与领取即时执行。新发现模型默认不启用。
- WorkBuddy 授权后后台签到，按账号和日期去重。活动逐项检查资格并串行领取，不明确结果记为待核对。
- 截断保留内容，通过原生会话“继续生成”发送新请求；同轮工具与恢复绑定原账号。系统指令、工具配对和原始历史保留。
- 日志按需打开，含错误码、账号、模型、分配原因、耗时、已知用量和排查建议；不存提示词、回复、密钥或签名 URL，不自动上传。

账号优先临期赠送额度，再比较到期时间、可比较余额及最近使用情况。未知额度不当零，付费/未知路线需显式授权。不自动更换来源或模型。OpenCode 独立目录、回环监听和随机认证，桥接不扩大 DSH 工具权限。

## 开发与安装

运行 npm ci、npm run check、npm run check:package、npm pack。统一入口构建 host、React 客户端、Typert、声明及 patch。

见 [安装与回滚](docs/installation.md)、[实际验证](docs/verification.md)、[剩余事项](docs/remaining.md)。日常 desktop profile 已使用 Connect Router 替换 link-opencode，升级记录以实际验证文档为准。早期原型在 ../output/router-ui-prototype-20261026（5188，仅演示数据）；独立 DSH 验证在 5190。

反馈入口可预览脱敏诊断并经确认直接发送到 [公开 Issues](https://github.com/Yocaihua8/dsh-connect-router/issues)。首次使用 GitHub 官方设备授权，目标 App 为 Yocaihua8 Connect Router Feedback；不需要输入 GitHub 密码或提供 PAT。真实合成报告已通过插件发送并验收关闭，见 [测试 Issue #1](https://github.com/Yocaihua8/dsh-connect-router/issues/1)；没有上传实际账号日志。详见 [隐私说明](PRIVACY.md)。

来源见 [第三方声明](THIRD_PARTY_NOTICES.md)，OpenCode 复用模块已获作者 MIT 公开许可。目标 SDK 的 Zod 公告尚未解决；仍是实验性 alpha，完整真实调用验收未通过。vendor 提取脚本只供溯源，不要重新运行覆盖已适配代码。
