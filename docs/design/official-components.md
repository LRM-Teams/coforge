# 7. 组件：只用官方

- 公开首页 `features/landing` 保留已安装的 Spell / Magic UI 动效组件，其余控件同样只用官方组件；本节其余规则针对产品界面。
- 组件通过 `npx untitledui@latest add <name>` 安装到 `src/components/base/` 和 `src/components/application/`，**源码不改**。要改外观，在调用处传 `className`；要改行为，改调用方。
- 用户明确要求移除历史 lint 豁免后，仅有两处限定修补：`base/badges/badges.tsx` 和
  `application/app-navigation/base-components/nav-account-card.tsx` 的原生按钮替换为
  React Aria Button，保留官方样式和公开接口；未使用的 `base/select/select-native.tsx` 已移除。
  这不是任意修改官方源码的许可；升级时保留这两处限定修补并重新验证。
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
- `.oxlintrc.json` / `scripts/oxlint-plugin.js` 不得新增或扩大豁免，除非事先获得用户明确同意，
  官方组件也不例外。申请时写明具体文件、规则、原因和失去的检查；历史豁免不构成授权。
  产品代码（`src/features/**`、`src/components/ui/**`、`src/components/layout/**`、路由、测试）
  命中规则就改代码，不要放宽规则；任何地方都不写
  `oxlint-disable`、`@ts-ignore`、`@ts-expect-error` 注释。
