# CoForge 设计 Token 规范

状态：Untitled UI 官方 `theme.css` + CoForge 品牌覆盖层，替代此前手写的 shadcn token 映射（PR #156 之前）

更新时间：2026-09-09

适用范围：`apps/web` 的颜色 / 字体 Token

## 1. 现在的结构

自本次基础重建起，`apps/web` 的样式由三层构成，按导入顺序：

1. **`src/styles/theme.css`** — `npx untitledui@latest init` 生成，**不做任何手改**。定义 Untitled 官方的完整语义
   token 命名空间（`--color-bg-*`、`--color-text-*`、`--color-border-*`、灰阶 / 品牌 / 功能色的 50–950 数值梯度等），
   并通过 Tailwind v4 的 `--background-color-*`、`--text-color-*`、`--border-color-*`、`--ring-color-*`、
   `--outline-color-*` 命名空间把它们映射成 `bg-primary`、`text-tertiary`、`border-secondary` 这类工具类。
   暗色模式通过 `@layer base { .dark-mode { ... } }` 重新指向不同的梯度档位（例如 `--color-bg-brand-solid` 暗色下仍指向
   `--color-brand-600`，只有 `--color-bg-brand-solid_hover` 改指 `--color-brand-500`），而不是重写梯度本身。
2. **`src/styles/typography.css`** — 同样由 CLI 生成，未手改。
3. **`src/styles/coforge-theme.css`** — **唯一**允许覆盖 Untitled token 或新增 CoForge 专属 token 的文件。只做两件事：
   - 覆盖 `--color-brand-50…950` 梯度为 CoForge 紫（见下）；
   - 新增 Untitled 没有对应概念的 token：侧边栏底色/强调色、终端底色、头像占位色、在线/离线圆点色。

`src/styles.css` 依次 `@import` 上述文件（`theme.css`、`typography.css` 在前，`coforge-theme.css` 最后），
并保留必需的 `@plugin`、`@custom-variant dark`（现在指向 `.dark-mode` 而不是 `.dark`）、字体导入，以及仅供
落地页使用的旧 token 兼容层（见 [§4](#4-落地页的隔离-token)）。**Figma 规范表已作废**——组件不再手写十六进制色值，
一律使用 Untitled 的语义工具类；旧文档 §2/§3 的黑灰色/主色调/功能色映射表随 shadcn token 一并移除。

## 2. CoForge 品牌梯度

`coforge-theme.css` 覆盖的 `--color-brand-*`（色相约 254°，紫色）：

| 档位 | 取值      | 说明                                   |
| ---- | --------- | -------------------------------------- |
| 50   | `#f8f5ff` |                                        |
| 100  | `#efe8ff` |                                        |
| 200  | `#ded1ff` |                                        |
| 300  | `#c9b3ff` |                                        |
| 400  | `#a993ff` | 旧版暗色主按钮色，现用于强调/焦点环等 |
| 500  | `#8f6ff2` |                                        |
| 600  | `#5d36dc` | 品牌主色，`bg-brand-solid` 的取值      |
| 700  | `#4c2ab8` |                                        |
| 800  | `#3d2295` |                                        |
| 900  | `#332073` |                                        |
| 950  | `#21134d` |                                        |

Untitled 自己的暗色模式规则是**不改梯度数值，只改语义 token 指向哪一档**（见 §1）。`coforge-theme.css` 延续这个
机制，仅在 `.dark-mode` 下把 `--color-border-brand`、`--color-focus-ring` 指向 `--color-brand-400`
（即 `#a993ff`），其余语义 token 沿用 Untitled 官方默认指向。

> **已知偏差，待 Frank 确认**：原计划是暗色模式下品牌主按钮（`bg-brand-solid`）改用更亮的 `#a993ff`
> 并配深色文字（“dark ink”），视觉上对应旧版 `--primary: #a993ff` / `--primary-foreground: #101319`。
> 但官方 `Button` 组件（`src/components/base/buttons/button.tsx`，未做任何手改）对 `color="primary"`
> 硬编码 `text-white`，没有可覆盖的文字 token。若把 `--color-bg-brand-solid` 在暗色下也改成 `#a993ff`，
> 白色文字在这个偏亮的浅紫底上对比度不足。由于"官方组件不允许手改"是硬性要求，暗色下
> `--color-bg-brand-solid` 保留 Untitled 官方默认（仍是 `--color-brand-600` = `#5d36dc`，白字对比度约 6.9:1），
> `#a993ff` 只作为 `brand-400` 用在不放白字的场景（边框、焦点环、次要强调色块）。

## 3. CoForge 专属 token(Untitled 没有对应概念)

定义在 `coforge-theme.css` 的 `@theme` 块，随 `.dark-mode` 切换：

| Token                     | 亮色                                     | 暗色                                    | 用途                     |
| ------------------------- | ----------------------------------------- | ---------------------------------------- | ------------------------ |
| `--color-sidebar`          | `#f8f7fe`                                 | `#141720`                                | 侧边栏底色（`bg-sidebar`）|
| `--color-sidebar-fg`       | `#101319`                                 | `#f4f6fb`                                | 侧边栏默认文字            |
| `--color-sidebar-accent`   | `#ebeaf7`                                 | `#2b2544`                                | 侧边栏选中/hover 底色     |
| `--color-sidebar-accent-fg`| `#5d36dc`                                 | `#c5bafe`                                | 侧边栏选中态文字/图标     |
| `--sidebar-gradient`（非 `@theme`，仅供 `style` 使用）| `linear-gradient(180deg,#f6f5fe 0%,#faf9ff 100%)` | `linear-gradient(155deg,#21183b 0%,#171421 52%,#141720 100%)` | 侧边栏渐变背景，Tailwind 颜色工具类无法表达渐变，App Shell 通过内联 style 读取 |
| `--color-terminal`         | `#171b23`                                 | `#171b23`（明暗一致）                    | 终端/命令块底色           |
| `--color-terminal-fg`      | `#f4f6fb`                                 | `#f4f6fb`（明暗一致）                    | 终端/命令块文字           |
| `--color-avatar-1…6`       | `#7556b9` `#d18a38` `#b65757` `#5268b7` `#497665` `#ba5937` | 同亮色 | 无头像时的占位底色（设计稿用真实头像图，未定义专门配色）|
| `--color-online`           | `#1bb618`                                 | `#42c83f`                                | 在线/成功圆点             |
| `--color-offline`          | `#afbccb`                                 | `#778393`                                | 离线圆点                  |

## 4. 落地页的隔离 token

`/`（`src/features/landing/**`）视觉冻结，不随本次迁移变化，继续使用自己的 Base UI 控件
（`src/features/landing/controls/button.tsx`、`dropdown-menu.tsx`）。这些控件原先直接用
`bg-primary`、`text-primary-foreground`、`bg-muted` 等 shadcn 风格工具类——这些类名现在被 Untitled
占用并指向完全不同的颜色（Untitled 的 `bg-primary` 是"页面主背景"，不是品牌色）。为避免撞名，两个控件文件
改成 Tailwind v4 的任意变量语法，如 `bg-(--primary)`、`text-(--primary-foreground)`，不再使用会被 Untitled
覆写含义的工具类名。

这些裸 `--primary`、`--background`、`--secondary` 等变量本身定义在 `src/styles.css` 的
`.landing-page` / `.dark-mode .landing-page` 选择器里，取值是迁移前的旧 shadcn 取值原样保留
（例如 `--primary` 亮暗两态都固定为中性浅色 `#f4f6fb`，配深色文字 `#101319`——落地页的主按钮设计上就是不跟随
产品品牌色）。修改这些值会改变落地页的渲染结果，按规则**不应该改**，除非专门更新落地页视觉设计。

## 5. 字体

- `--font-body` / `--font-display`：Inter Variable（`@fontsource-variable/inter`），CJK 回退
  `"PingFang SC"`、`"Microsoft YaHei"`、`"Noto Sans CJK SC"`。
- `--font-mono`：Geist Mono Variable（`@fontsource-variable/geist-mono`）。
- `--font-landing-display`：Geist Variable，仅落地页展示文字使用，产品其余部分不再用 Geist Sans。

## 6. 维护约定

- 颜色一律用 Untitled 的语义工具类（`bg-primary`、`text-tertiary`、`border-secondary`……),不写死十六进制,
  不写 `bg-[...]` 任意值,新概念先加 token 再用。
- 只在 `coforge-theme.css` 覆盖 `--color-brand-*` 或新增 CoForge 专属 token；`theme.css` / `typography.css`
  保持 CLI 生成的原样,不手改,升级时直接用 `npx untitledui@latest init` 重新生成再对比 diff。
- 落地页的 `.landing-page` 隔离层只服务于视觉冻结,新功能页面不要引用这里的变量。
