# 8. 页面骨架与密度

参照 Linear、Notion 和 Untitled UI 自带的 sidebar-navigation。

- 应用侧栏用官方 `SidebarNavigationSimple`（展开，280px）和 `SidebarNavigationSlim`（收缩，68px）。侧栏底色用 CoForge 的 `--color-sidebar`（亮 `#f8f7fe`，暗色为紫黑渐变），右侧一条 `border-secondary`。这是唯一有意偏离官方（官方侧栏是 `bg-primary`）的地方，目的是品牌辨识。
- 内容区 `bg-primary`，贴边铺满。页面内的多个面板（列表 + 详情、对话 + thread）之间只用 1px `border-secondary` 分隔。
- **不用**卡片岛屿：页面级面板没有 `rounded`、没有 `border` 包边、没有 gutter、没有阴影。卡片只用于内容里真正独立的对象（一个附件、一条运行时），以及[第 9 节](field-display.md)的事实列表分组。设置页（语言和地区、偏好设置）按设计稿例外：每组一个图标加大写小标题，组内每个设置或每个保存单元一张卡片（`rounded-xl border border-secondary shadow-xs`），开关放行尾，存在本设备的设置在卡片里注明「仅保存在此设备上」。
- 侧栏可拖拽：默认 280，范围 240 到 360。手柄不可见，热区 6 到 8px 压在分隔线上，hover 或拖拽时显示 2px 品牌色线。
- 页头高度 48px（`h-12`），标题 `text-lg font-semibold`，右侧放主操作。侧栏 logo 行同高，logo 和页面标题共一条基线。页头下方的二级操作区（筛选、工具条）高 44px（`h-11`），里面的控件一律 36px（`size="sm"`），不另加上下内边距。标签带例外：官方 `button-border` 标签组连外框高 44px，所以标签带高 56px（`h-14`），标签组上下各留 6px。会话页不另起标签带：Chat / Tasks / Files 是官方横向 `underline` 标签（`size="md"`，图标 + 文字），在页头这一行居中、压在页头底线上，激活标签的品牌色下划线替代它下面那段底线；对话区（按容器宽度，不按视口）窄于 `@2xl` 时标签掉到标题下面第二行（`conversation-header.tsx`）。
- 操作区光学对齐：无边框的按钮排（`color="tertiary"` 的 `Button` 标签带、`ButtonUtility` 图标簇）让按钮**内容**（图标或文字）对齐面板沟槽，用负 margin 抵消按钮内边距——`size="sm"` 按钮是 `px-3`，左缘用 `-ml-3`；`ButtonUtility` 是 `p-1.5`，用 `-ml-1.5`，右缘镜像用 `-mr-1.5`。激活态的浅色药丸盒超出沟槽那 12px 是有意的（Linear、Notion 同）。有边框的盒式控件（Input、Select、`ButtonGroup`、`button-border` 标签组、卡片）反过来：盒边缘对齐沟槽，**不加**负 margin。范例：Agent 面板的标签带是官方 `Tabs` 的横向 `button-border`（`reorderable-tab-strip.tsx`），盒边缘对齐沟槽。
- 可交互元素 hover 一律显示小手：`styles.css` 的基础层已让 `button:not(:disabled)` 全局 `cursor: pointer`，链接走浏览器默认；非 button 的自定义触发器（`role="button"`、hover popover 触发器、可点 chip）必须自己显式补 `cursor: pointer`。禁用态用 `cursor: not-allowed`（官方 Button 自带）。不要用 `cursor: default` 暗示可点。

## 密度

- 正文字号 `text-sm`（14px），`text-md`（16px）只用于对话正文和空状态标题。`text-xs` 只用于时间戳和徽章。
- 列表行高 40 到 48px，字段行高 44px，表格行高 44px。
- section 之间 `border-secondary`，section 内边距 `py-6 px-8`。
- 页面能一屏看完的，不要让它两屏。

### 聊天消息流

用户确认参考 Slack 消息流：采用保留头像的 [Clean 布局](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed)，不是隐藏头像的 Compact 模式或左右气泡。
消息、附件和任务引用沿正文列左对齐；同一发送者五分钟内的连续消息合组，跨日期不合组。
短日期分隔与时分时间戳承担辅助信息，已有 thread 才在消息下显示回复摘要。
[Slack thread 示例](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions)是按需消息操作的参考；Web 的触摸适配保留无描边的消息菜单入口，不能只靠 hover。
输入区与附件排版参考 [Untitled Messaging examples](https://www.untitledui.com/react/components/messaging)，继续组合已安装的官方基础组件，不复制受 PRO 授权限制的源码。
“作为任务发送”放在输入区次级菜单，开启后显示可取消的模式标签，成功发送后恢复普通消息。
