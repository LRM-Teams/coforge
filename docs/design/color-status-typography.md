# 11. 颜色、状态、排版与深色模式

## 颜色

- 语义 token 用官方名：`bg-primary / bg-secondary / bg-tertiary`，`text-primary / text-secondary / text-tertiary / text-quaternary`，`border-primary / border-secondary`，`bg-brand-solid`，`text-brand-secondary`，`text-error-primary`。映射表见 `docs/design-tokens.md`。
- 品牌紫只出现在：侧栏选中项、主按钮、链接、Public 徽章、自己发出的消息气泡、焦点环，以及两类交互状态（2026-09-23 确定）：
  - 未读提示：未读数字角标、未读小圆点、未读会话行的底色、消息流里的未读分割线；
  - 当前焦点与交互：选中的卡片/列表行/设置导航项（边框或文字）、@提及高亮、拖拽落点与选择指示、可拖拽分隔线的 hover/拖动态。

  其他地方一律灰阶：角色徽章（owner/admin/成员）、状态点与进度、装饰性图标和渐变都不用品牌紫。
- "主按钮"指一个界面里唯一的主动作：弹窗的确认键、onboarding 空状态的引导键，以及页头里该页面唯一的创建类主操作（如成员页的「新建智能体」「邀请」，2026-09-23 按设计稿确定）用 `color="primary"`。一个页头最多一个 primary；页头的其他操作和工具栏按钮一律 `color="secondary"`。其他页面的页头主操作改到时再按本条调整。
- **按钮尺寸**：按钮高度只用 `size` 控制，不用 `h-*` / `py-*` 覆盖；产品界面统一默认 `sm`（36px），弹窗页脚、空状态、页头都是；`lg` 只用于登录和设备授权页；空状态引导键只有 onboarding（如 Add computer）用 primary，其余 secondary。
- 语义色（success / error / warning）和品牌色分开，状态不用紫。
- 不写十六进制颜色，不写 `text-white` 之外的硬编码。

### 危险操作

- 这里的危险操作指撤不回来的操作（删除、重置、移除）。能撤回的操作（归档、退出、隐藏，之后可以恢复）不算：入口键用普通 `secondary`，确认键用普通 `primary`，不用红色。
- 危险操作分两步：入口键打开流程，确认键完成它。两者用哪种红，取决于"它是不是一个按钮"，不取决于它有多危险。
- 确认键（最后那一下，不可撤销）：`color="primary-destructive"`（实心红）。一个危险操作面里只允许一处实心红；有等待态用 `isLoading` + `showTextWhileLoading`。
- 入口键（打开删除 / 重置 / 移除流程的那个按钮）：`color="secondary-destructive"`（描边红字）。它本身就是一个按钮，就要长得像按钮；纯红字放在页脚、设置分区或竖排操作区里会读成一段文字，而不是可点的东西。
- `color="tertiary-destructive"`（纯红字）只用在本来就没有按钮形态的位置：列表行的 hover 操作、下拉菜单项、图标按钮。正文里的真链接用 `link-destructive`。
- 说明文字不装进红色警示框，用 `FeaturedIcon` + 灰色描述（参照 `weekly-send-confirm-dialog.tsx`）。
- 选中项卡片不用红色，和非危险选项同款。
- 按钮图标一律走 `iconLeading`，不作子元素，否则图标会挤到文字上方。

## 状态与徽章

- 在线状态用头像右下的圆点（官方 Avatar 的 `status`），不单独写 "Online" 文字，除非在页头徽章里。
- 徽章用官方 `Badge`：品牌色 = 对外可见（Public），灰 = 默认（Private），绿 = 成功 / 在线，红 = 错误。徽章不是按钮，不加描边按钮样式。
- 任务状态有自己的一组颜色（`features/tasks/task-workflow.tsx` 的 `TASK_STATUS_COLOR`，看板和任务弹窗共用）：待办橙、进行中蓝、验收中靛蓝、已完成绿、已关闭灰。只用于任务状态，不借给别的概念。

## 排版

- UI 字体 Inter，中文回退苹方 / 微软雅黑 / Noto Sans CJK。代码、终端、标识符用 JetBrains Mono。Geist Sans 只用于公开首页标题。
- 时间戳和计数加 `tabular-nums`。

## 深色模式

- 用 Untitled 的 `dark-mode` 类，`theme.css` 原样使用。
- 所有颜色只走 token，不允许 `dark:` 前缀里写具体颜色。
- 每个新页面亮暗各截一张图再合并。
