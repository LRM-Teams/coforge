# 12. 尺寸单位：rem 与 px

一句话：**会影响排版和阅读的尺寸用 rem，细线用 px。**

原因：设置里的「文字大小」（`features/settings/text-size.ts`）通过改 `<html>` 的 `font-size` 缩放整个界面，浏览器和系统的默认字号设置也只作用于根字号。rem 是根字号的倍数，会跟着一起缩放；px 是固定值，不会。文字变大而 px 写死的宽度、间距不变，就会换行变多、挤压或溢出（[WCAG 1.4.4 Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html)）。

## 用 rem

字号、行高、间距（padding / margin / gap / 缩进）、宽高、最小/最大宽度、网格列宽、圆角、图标和头像尺寸、定位偏移。

- 首选 Tailwind 刻度，它本身就是 rem：Tailwind v4 的 `--spacing` 是 `0.25rem`，`p-4` = 1rem，`size-12` = 3rem；`theme.css` 的字号是 `--spacing` 的倍数（`text-sm` = 0.875rem）；圆角用 `rounded-md/lg/xl` 等 token（`--radius-*` 是 rem）。
- 刻度里没有的值写 rem 任意值：`w-[18rem]`、`md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]`、`max-w-[36rem]`。不写 `w-[280px]`、`text-[10px]`、`rounded-[10px]`。
- 断点用 Tailwind 的 `sm/md/lg/xl` 刻度，不写 `min-[1024px]:`。注意媒体查询里的 rem 取浏览器默认字号，不随应用内「文字大小」变化；用刻度断点是为了全站一致。`xs`/`xxs` 是 `theme.css` 定义的 px 断点，照用即可。窗格宽度决定布局时（例如旁边打开了资料面板），用容器查询 `@container` 而不是视口断点。
- 内联 `style` 里的数字在 React 中按 px 处理：`style={{ paddingLeft: 16 }}` 是 16px。要写成 rem 字符串，例如树形缩进 `style={{ paddingLeft: `${0.25 + (level - 1)}rem` }}`，或改用 CSS 变量加 Tailwind 类。
- 自写 CSS 文件同样适用：`max-height: 18.75rem`，不写 `max-height: 300px`。

## 用 px

不应该随文字放大的细节，放大它们只会让界面变粗糙：

- 边框、分隔线、描边：`border`、`ring-1`、`divide-y`、`outline-offset-2`、`1px solid`。Tailwind 的 `border` / `ring` / `outline` 宽度本来就是 px，直接用。
- 图标线条粗细：`stroke-[2.25px]` 这类。
- 阴影、模糊：`shadow-*` token、`blur(8px)`。
- 从 DOM 量出来的实际位置和尺寸：`getBoundingClientRect()`、`scrollTop`、拖拽坐标都是 px，据此定位浮层时直接用 px，不要换算成 rem。
- `sr-only` 这类 1px 隐藏技巧。

## 不受约束的范围

- Untitled UI 官方组件（`src/components/base/**`、`application/**`、`foundations/**`）按[第 7 节](official-components.md)源码不改，里面的 `rounded-[10px]`、`pr-[calc(...+1px)]` 等保持上游原样。
- `theme.css` / `typography.css` 保持 CLI 生成的原样（见 `docs/design-tokens.md`）。
- 公开首页 `features/landing` 按冻结视觉保留。

## 文档里的像素数

本文里写的 `48px`、`36px` 这类数字，是默认文字大小（根字号 16px）下对应 Tailwind 类的换算，方便对照设计稿（`h-12` = 3rem = 48px）。实现时写括号里的 Tailwind 类，不要照着数字写 `h-[48px]`。

## 存量

2026-09-23 盘点，产品代码里还有布局类 px 的文件：`features/records/report-editor/table-controls.tsx`（量出来的定位保留 px，`size-[...]`/`gap-[...]`/圆角改 rem）、`report-editor/code-block-iframe.tsx`、`report-editor/styles/code.css`（`max-height`）、`features/computers/computer-tile.tsx`、`computers-pending.tsx`、`components/settings-content.tsx`（`grid-cols`）、`features/workspaces/workspace-switcher.tsx`、`invite-member-dialog.tsx`、`features/projects/create-project-dialog.tsx`、`project-file-tree.tsx`（缩进）、`features/conversations/channel-members-dialog.tsx`、`features/agents/profile-panel/agent-workspace-tab.tsx`（缩进）。另有：`report-editor/code-block-static.tsx`、`report-editor/extensions/slash-command-suggestion.tsx`（`max-h-[300px]`）、`report-editor/extensions/code-block-view.tsx`（`h-[480px]`）、`features/conversations/own-messages-menu.tsx`（`max-h-[400px]`）、`components/login-page.tsx`（`max-w-[360px]`）、`components/ui/hover-popover.tsx`（`max-w-[calc(100vw-24px)]`）、`report-editor/styles/shell.css`（`min-width: 300px`、`max-width: min(360px, …)`）、`report-editor/styles/media.css`（`max-width: min(100%, 640px)`），以及 px 媒体查询 `report-editor/styles/prose.css`（768px）、`styles/attachment.css`（767px）。改到这些页面时顺手按本节改掉；新代码不得再增加。
