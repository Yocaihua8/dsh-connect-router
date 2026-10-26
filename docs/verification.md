# 验证记录 · 2026-10-26

## 当前状态

用户已确认“可以，按当前原型实现正式 UI”。客户端使用 DSH 原生设置、Menu、模型选择器及会话发送接口，正式包不含原型工具栏或演示数据。

隔离 home：../../output/router-dsh-acceptance-20261026/home；profile router；回环端口 5190。**home 含真实 DSH 凭据，不打包、不公开。** 截图放同级 evidence，日常 profile 未安装本插件。

## 自动化

本次修订 npm run check 通过：65 项测试、三个 TypeScript 工程以及完整 host/client/Typert 构建。命令及结果见 release-checks.json。

- npm run check：生成 host/client/Typert/声明、三个 TypeScript 工程、node:test。
- npm run check:package：统一登记、入口、导出、声明、patch 与第三方材料检查。
- 原型 npm test / npm run test:sites / npm run build：仅原型验证。
- 用例覆盖中文跨字节、半帧/尾帧、缺少终止、工具参数截断、取消、上下文错误、摘要预算/停止、宿主维护触发/保护、图片序列化、费用未知、能力关闭、草稿失败/撤销、账号隔离/排序/并发绑定、领取去重、日志脱敏/分页/轮转。
- npm audit：39 个 high 依赖节点受同一 Zod GHSA-mrhx-c7xc-m3w5 影响，不是 39 个独立漏洞。SDK rc.3 精确依赖 4.4.3，未强制升级。报告在 ../../output/router-revision-2-backup/audit-formal.json。

## 实际隔离验收

| 项目 | 结果及边界 |
|---|---|
| 插件安装 / native settings.section | 成功，DSH 0.2.1-rc.3 |
| 设置持久化 | OpenCode Big Pickle 启用及 64K 重启保留，原生选择器可见 |
| OpenCode 公共目录 | 读取 7 后刷新为 9 项，随上游变化；新增默认不启用 |
| 统一测试 | 匿名来源成功，CONNECTION_TEST，仅授权和目录 |
| OpenCode 对话 | 15:24 Big Pickle 返回 UPSTREAM_REJECTED，未收到回答 |
| WorkBuddy 扫码 | 用户自行微信扫码，15:25:55 授权完成并保存 DSH 凭据 |
| WorkBuddy 目录 / 额度 | 61 项目录保留；额度按同单位汇总，原始桶仅在明细展开 |
| 自动签到 | 15:25:56 AUTO_CHECKIN confirmed；福利页已签到 |
| 福利活动 | 两项活动均已领取，暂无可领取活动，未重复领取 |
| WorkBuddy 对话 | 15:28 Hy3（cn/hy3，32K）HTTP 400 / UPSTREAM_CHANNEL_REJECT，约 283ms |
| 工具 / 媒体 / 恢复 | 未真实验收，聊天被上游拒绝 |
| 多账号 / Zen / Go | 无第二实际账号及 Key，未真实验证 |
| 日常 / Electron | 未执行，仅隔离 DSH web 原生 UI |

固定源码将业务码 11128 分类为通道拒绝。调用使用其聊天协议和会话头，保留 DSH attribution；不采用 shim 的提示词扰动。“已连接”与“聊天可用”分别记录。

宿主可能另发会话标题请求；标题和摘要结果不覆盖主会话恢复状态。日志按请求分别记录，不把目录或签到成功当作对话通过。

## 正式 UI 浏览器检查

- 在实际 540×604 和 1280×800 视口检查；尺寸以 DOM 与截图共同核对。旧截图名 models-light-narrow.png 实为早期深色截图，不能用作浅色通过证据；最终证据使用 *-final.png。
- 深浅主题的模型主行、紧邻费用标记、平铺上下文及菜单通过；窄屏侧栏为版本限定样式的图标布局。原生菜单 Esc、外部点击、键盘选择通过。
- Hy3 修改 64K 和关闭工具能力后，切页保留草稿；撤销恢复 32K 和工具开启。自定义 4095 显示 4096–192000 校验错误且无法保存。OpenCode Big Pickle 保持独立 64K。
- 重启保留 WorkBuddy 凭据、目录和设置；启动签到再次核对已签到状态，领取去重模块测试确认不重复提交。
- WorkBuddy 统一测试通过，61 项目录。浅色日志按 WorkBuddy + 拒绝筛选，详情包含 HTTP 400、错误码、耗时与排查建议。
- 实际点击导出诊断包，得到 1 条筛选记录。检查无密钥/正文敏感字段和授权/签名 URL，副本为 evidence/diagnostics-redacted.json。没有上传。
- 交互检查时浏览器 warn/error 为空；最后一次宿主重启加载页面时捕获到 DSH locale / uiConversation.binding 的 unknown session 初始化错误，栈位于宿主会话视图。设置页可用，另行刷新复查；不能将整个启动过程记作零错误。临时主题恢复为跟随系统。真实保存失败分支由控制器受控测试覆盖，未故意破坏真实存储制造失败。
- 最后一处账号绑定修复有新增回归测试：标题使用独立绑定，摘要继承主账号且不改写最近对话绑定，重启续写仍使用原账号。

## 历史与副作用

最初仅后端时 34 项测试通过，无 UI/patch；旧“不能安装”结论已过期。独立 OpenCode 1.18.30 曾在 90 秒超时前返回 Free usage limit reached，后加入 retry 中止和先订阅后发送；原生 DSH 快速拒绝是后续复验。

一次构建命令误在根目录执行，重建了 dsh-memory 生成产物并开始 dsh-automation 构建后中止；已告知用户。没有修改这些插件源文件、原 OpenCode 工作树或日常安装，相关生成产物不纳入 Router 包。

## alpha.2 额度、上下文和反馈修订

- 2026-10-26 直接读取授权账号的 WorkBuddy 目录，61 项保留。容量字段为 maxInputTokens / maxOutputTokens，未发现独立默认窗口字段。Hy4 preview 为 960,000，MiniMax M3 为 512,000，GLM-5.3 等部分模型为 1,000,000；没有统一提高其他模型上限。
- 65 项测试通过；新增同单位额度合并、过期和未知值、256K / 960K / 1M，反馈白名单脱敏、48 KiB 按完整记录裁减、并发一次发送、重启回执、只读核对、权限/限流、设备取消/失效/网络恢复、并发刷新及全部反馈 RPC 的 owner 拒绝测试。
- 540×604 浅色实际界面验证单条额度汇总、明细展开、福利账号菜单与 Esc、福利记录默认折叠。GLM-5.3 选择 1M 后显示草稿，撤销恢复；仅上下文区域横向滚动，页面宽度没有溢出。深色对应额度、来源菜单及 1M 视图另有本地截图。
- 连接与恢复默认不铺开日志，查看日志打开原生弹层。使用“长度限制”空筛选生成合成测试预览，报告明确包含 0 条真实日志；实际发送仍等待 GitHub 官方网页授权完成。
- GitHub App 已注册并仅安装到 Yocaihua8/dsh-connect-router；Issues 读写、元数据只读，设备流及 token 到期启用，webhook 关闭。无 App Secret / 私钥。首次网络失败已修正为可辨识错误并保留有效期内的设备等待；GitHub 官方确认页曾持续禁用 Authorize，已请用户完成网页步骤。
- 1280×800 浅色反馈预览可滚动检查完整正文。实际反馈发送、链接验证及关闭测试 Issue 尚待完成，不能用模块测试代替。

本轮证据存放开发机 output/router-revision-20261026/evidence，不随源码上传；其中额度截图含本机账号显示。GitHub 反馈测试仅允许合成说明及空日志，不上传该截图或真实诊断。
- 本轮补查 1280×800 深色额度图及菜单、540×604 深色 960K 模型行；五个日志筛选菜单均在视口内，最长模型菜单高 580px（604px 视口内）。浅色福利菜单、额度图、1M 主行与桌面反馈预览均有截图。临时主题恢复跟随系统，测试草稿均已撤销。
- 未知额度的无障碍说明同步显示“额度未知”，不将没有已知余额的类别标为 0。日志时间与事件之间增加明确分隔。
- 公开源码已推送至 https://github.com/Yocaihua8/dsh-connect-router ，排除 lib、node_modules、缓存、真实 home、日志和截图；Git 提交使用 GitHub noreply 邮箱。补充的 MIT 许可仅适用于已确认的 OpenCode 五个模块，原工作树未改动。
