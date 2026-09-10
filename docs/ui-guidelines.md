# CoForge 产品 UI 规范

状态：生效（2026-09-09 定稿）。适用于 `apps/web` 的产品界面，不含公开首页（`features/landing`）。

这份文档回答"一个新页面该长什么样"。没有设计师，所以规则要少、要硬：能用 Untitled UI 官方决定的地方一律用官方的，这里只写官方没有规定、或我们有意偏离的部分。

## 1. 来源与优先级

1. Untitled UI React 官方组件和 `theme.css`（<https://www.untitledui.com/react/docs>，源码 <https://github.com/untitleduico/react>）
2. 本文档
3. 其他任何来源（Tailwind UI 示例、shadcn 习惯、个人偏好）都不作为依据

冲突时上面的赢。发现本文档和官方冲突且没有写明"有意偏离"，按官方改本文档。

## 2. 组件：只用官方

- 组件通过 `npx untitledui@latest add <name>` 安装到 `src/components/base/` 和 `src/components/application/`，**源码不改**。要改外观，在调用处传 `className`；要改行为，改调用方。
- 例外：`application/app-navigation/sidebar-navigation/` 下的 `sidebar-simple.tsx`、`sidebar-slim.tsx`
  和 `base-components/mobile-header.tsx` 是官方的**演示模板**（写死 Untitled 自己的 logo、搜索框、假账号卡片、固定像素宽度），不是可参数化的
  组件。这两个文件允许复制到 `src/components/layout/sidebar/` 后按需修改；复制之后就是 CoForge 自己
  的代码，不再受"源码不改"约束。复制体内部继续调用的 `app-navigation/base-components/**`
  （`NavItemBase`、`NavButton`、`NavList`、`MobileNavigationHeader` 等）和 `components/base/**`
  仍然原样不改。
- 升级用 `npx untitledui@latest upgrade`，升级后跑 `bun run check` 和 `bun run test`。
- 允许自写的只有官方没有对应物的原语，放在 `src/components/ui/`：Empty、Skeleton、Toast 包装、RelativeTime、InputOTP、HoverPopover。自写原语只能组合 React Aria 和官方组件，不能复制官方文件再改。
- `src/components/ui/README.md` 维护"偏离官方组件清单"：每个自写文件一行，写明为什么官方没有。清单之外不允许出现非官方组件。
- 图标只用 `@untitledui/icons`。厂商 logo（Claude Code、Codex 等）用 `@lobehub/icons-static-svg`。
- `.oxlintrc.json` / `scripts/oxlint-plugin.js` 只允许一种改动：给 `src/components/base/**`、
  `src/components/application/**` 下**未改动的官方文件**豁免 CoForge 自定义规则
  （`coforge/no-native-button`、`coforge/no-native-select`、`coforge/no-native-title`），每条豁免
  写明具体文件，理由写进提交信息。绝不豁免产品代码（`src/features/**`、`src/components/ui/**`、
  `src/components/layout/**`、路由、测试）——命中规则就改代码，不要放宽规则；任何地方都不写
  `oxlint-disable`、`@ts-ignore`、`@ts-expect-error` 注释。

## 3. 页面骨架：平铺，一条发丝线

参照 Linear、Notion 和 Untitled UI 自带的 sidebar-navigation。

- 应用侧栏用官方 `SidebarNavigationSimple`（展开，280px）和 `SidebarNavigationSlim`（收缩，68px）。侧栏底色用 CoForge 的 `--color-sidebar`（亮 `#f8f7fe`，暗色为紫黑渐变），右侧一条 `border-secondary`。这是唯一有意偏离官方（官方侧栏是 `bg-primary`）的地方，目的是品牌辨识。
- 内容区 `bg-primary`，贴边铺满。页面内的多个面板（列表 + 详情、对话 + thread）之间只用 1px `border-secondary` 分隔。
- **不用**卡片岛屿：页面级面板没有 `rounded`、没有 `border` 包边、没有 gutter、没有阴影。卡片只用于内容里真正独立的对象（一个附件、一条运行时）。
- 侧栏可拖拽：默认 280，范围 240 到 360。手柄不可见，热区 6 到 8px 压在分隔线上，hover 或拖拽时显示 2px 品牌色线。
- 页头高度 48px（`h-12`），标题 `text-lg font-semibold`，右侧放主操作。侧栏 logo 行同高，logo 和页面标题共一条基线。页头下方的二级操作区（筛选、tab、工具条）高 44px（`h-11`），里面的控件一律 36px（`size="sm"`），不另加上下内边距。

## 4. 字段展示：label 在上，value 在下

全站只有这一种方向。表单也是（官方 Input 的 label 就在上方），读和写是同一套语法。

- label：`text-sm text-tertiary`，常规字重。value：`text-sm font-medium text-primary`。两者间距 4px。
- 多个字段排成网格：`md:grid-cols-2 xl:grid-cols-3`，`gap-x-8 gap-y-6`。长值（路径、命令、URL）独占一整行。
- 字段之间不画线。只在 section 之间画一条 `border-secondary`，section 内边距 `py-6 px-8`。
- 标识符类的值（主机名、版本号、ID、路径）用 `font-mono`。
- 可编辑字段外观和只读字段一致。hover 出现浅底和铅笔，点击原地换成官方 Input 加 Save / Cancel，Escape 取消。不要常驻的编辑图标。
- 空值显示 `—`，不显示 "N/A"、"Unknown"、"暂无"。

## 5. 信息层级：每个事实只出现一次

这是最常被违反的一条。

- **页头承担"扫一眼"**：名字、状态徽章、两三个最关键的事实（OS、版本、时间）放在页头一行灰字里。
- **正文不重复页头**。页头已经有的信息，Overview 里不再列一遍。
- 列表项已经显示的信息（版本号、状态点），详情页头不再以同样形式重复。
- 同一个对象的两个表示相同时只显示一个：`andong3` 和 `@andong3` 只留一个；显示名和主机名相同时只留一个。
- 相关的事实合并成一句：`Added by <头像> andong3 · 6h ago` 代替 Creator 和 Added 两个字段。

## 6. 少写字

- 不写解释性提示句（"Hover a runtime to see usage"）。交互该由控件外观暗示，暗示不了就改控件。
- 值里不带 label 的前缀："2.1.266" 而不是 "Version 2.1.266"，label 已经是 Version。
- 徽章只写状态词：Online、Public、Private。不写 "Status: Online"。
- 按钮只写动词：Restart、Save、Add。不写 "Click to restart"。
- 空状态一句话：说明为什么空和下一步做什么，不超过两行。

## 7. 密度

- 正文字号 `text-sm`（14px），`text-md`（16px）只用于对话正文和空状态标题。`text-xs` 只用于时间戳和徽章。
- 列表行高 40 到 48px，字段行高 44px，表格行高 44px。
- section 之间 `border-secondary`，section 内边距 `py-6 px-8`。
- 页面能一屏看完的，不要让它两屏。

## 8. 颜色

- 语义 token 用官方名：`bg-primary / bg-secondary / bg-tertiary`，`text-primary / text-secondary / text-tertiary / text-quaternary`，`border-primary / border-secondary`，`bg-brand-solid`，`text-brand-secondary`，`text-error-primary`。映射表见 `docs/design-tokens.md`。
- 品牌紫只出现在：侧栏选中项、主按钮、链接、Public 徽章、自己发出的消息气泡、焦点环。其他地方一律灰阶。
- "主按钮"指一个界面里唯一的主动作：弹窗的确认键、空状态的引导键。页头和工具栏里的操作按钮（New agent、Add computer、Create task）一律 `color="secondary"`，参照 Linear 和 Notion。
- 语义色（success / error / warning）和品牌色分开，状态不用紫。
- 不写十六进制颜色，不写 `text-white` 之外的硬编码。

## 9. 状态与徽章

- 在线状态用头像右下的圆点（官方 Avatar 的 `status`），不单独写 "Online" 文字，除非在页头徽章里。
- 徽章用官方 `Badge`：品牌色 = 对外可见（Public），灰 = 默认（Private），绿 = 成功 / 在线，红 = 错误。徽章不是按钮，不加描边按钮样式。

## 10. 排版

- UI 字体 Inter，中文回退苹方 / 微软雅黑 / Noto Sans CJK。代码、终端、标识符用 Geist Mono。Geist Sans 只用于公开首页标题。
- 时间戳和计数加 `tabular-nums`。

## 11. 深色模式

- 用 Untitled 的 `dark-mode` 类，`theme.css` 原样使用。
- 所有颜色只走 token，不允许 `dark:` 前缀里写具体颜色。
- 每个新页面亮暗各截一张图再合并。

## 12. 新页面检查单

1. 只用官方组件和 `components/ui` 清单里的原语
2. 平铺发丝线，没有卡片岛屿
3. 字段 label 在上，网格排布
4. 页头和正文没有重复的事实
5. 没有提示句，值里没有 label 前缀
6. 只用语义 token，品牌紫只在第 8 节列的位置
7. 亮暗两张截图都看过
