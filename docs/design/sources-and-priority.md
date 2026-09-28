# 1. 来源与优先级

- 保留真实业务含义、用户任务、权限与安全要求，以及可访问性；不能为了简洁隐藏风险或改变事实。
- 本文是 `apps/web` 产品界面唯一的设计规范（原 `docs/ui-guidelines.md` 已并入第 7–13 节），颜色与字体见 design-tokens.md。不另建设计或 UI 规范文档，规则变化直接改本文。
- **有设计稿时以设计稿为准**（2026-09-23 确定）：页面结构、控件选择、主次、间距和文案按设计稿实现，实现时仍用 Untitled UI 官方组件和 rem 刻度。设计稿与本文冲突时按设计稿做，并在同一改动里修改本文对应条款；设计稿没覆盖的部分按本文。设计稿里有、产品里没有对应数据或概念的内容（例如运行统计、归档），先向需求方确认，不编造数据或新概念。
- 没有设计稿时，组件与样式的依据顺序：Untitled UI React 官方组件和 `theme.css`（<https://www.untitledui.com/react/docs>，源码 <https://github.com/untitleduico/react>）优先，其次是本文；Tailwind UI 示例、shadcn 习惯或个人偏好都不作为依据。本文与官方冲突且没写明“有意偏离”时，按官方改本文。
- 颜色以 Figma 与 [design-tokens.md](../design-tokens.md) 的维护约定为准；实现复用 [styles.css](../../apps/web/src/styles.css) 和 [UI primitives](../../apps/web/src/components/ui)。本文不重复维护 Token 值。
- 复用宿主的 TanStack Start、Tailwind、Untitled UI（React Aria）、图标和本地化约定。不引入另一套主题、组件库或 Vercel 品牌 CSS。
- 本文负责内容层级、渐进披露和评审方法。Figma 尚未确定的字体、间距等不得由 Agent 编造成已批准的品牌标准；当前实现也不自动等于认可的设计范例（第 7–13 节点名的范例除外）。
- `design-taste-frontend` 的营销页规则不作为工作台默认值。不要为“去 AI 味”删除现有品牌紫、真实状态点、有效列表或表格，也不要强制添加图片、非对称布局或动效。
