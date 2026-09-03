# CoForge 设计 Token 规范

状态：与 Figma《Coforge UI 设计规范》同步

更新时间：2026-09-03

适用范围：`apps/web` 的颜色 Token（`apps/web/src/styles.css`）

## 1. 规范来源

设计侧唯一来源是 Figma 文件 *River 新版设计方案* 中的画板 **Coforge UI 设计规范**：

- 文件：<https://www.figma.com/design/B0tLPylcm6pLiNzz1JXQnC/>
- 画板节点：`2672:8421`（所在页面 `2672:6903`「2026.08.26 页面、规范与组件」）

该画板标注了「⚠️ 持续更新！」。**当前规范仍只包含 Color 一节**，尚无字体、间距、圆角、阴影等章节；本文同步范围与之一致，不自行补充设计侧尚未确定的内容。

## 2. 颜色 Token 映射

代码侧的 Token 定义在 `apps/web/src/styles.css` 的 `:root` 中，并通过 `@theme inline` 暴露为 Tailwind 的 `--color-*` 工具类。

### 黑灰色

| 色值 | 使用场景（设计侧） | CSS 变量 |
| --- | --- | --- |
| `#101319` | 标题 / 对话正文 / 未选中的导航名称 / 未选中的 icon | `--foreground`、`--card-foreground`、`--popover-foreground`、`--secondary-foreground`、`--sidebar-foreground` |
| `#777D8D` | 对话预览行 / tab 文字 | `--muted-foreground` |
| `#E0E5F1` | 投影 / 边框 / 分割线 | `--border`、`--input`、`--sidebar-border` |
| `#F4F6FA` ⚠️ | tab 背景 / 对话内容背景 / 对话选中背景 | `--secondary`、`--muted` |

> ⚠️ **规范表标注疑似笔误，待设计确认（截至 2026-09-03 画板上仍未修正）**：这一行的**文字标注写的是 `#F4FAF6`（偏绿）**，但**同一行的色块实际填充是 `#F4F6FA`（偏蓝）**，`FA` / `F6` 疑似写反。
> 设计稿页面上量到的是 `#F3F6FA`（「电脑」标签、数据标签、分段控件底色三处一致），与色块只差 1/255。
> 同组的 `#777D8D`、`#E0E5F1` 都是偏蓝的灰，`#F4FAF6` 是整张表里唯一偏绿的中性色。
> **代码按色块实际填充取 `#F4F6FA`。**
> 若设计确认应为页面上的 `#F3F6FA`，只需再改 `--secondary` / `--muted` 两处。

### 主色调

| 色值 | 使用场景（设计侧） | CSS 变量 |
| --- | --- | --- |
| `#101319` | 标题 / 对话正文 / 按钮 / 未选中的导航名称 / 未选中的 icon | `--primary` |
| `#5D36DC` | 选中的导航名称 / 选中的 icon / 消息标签 / @用户名 | `--brand`、`--ring`、`--accent-foreground`、`--sidebar-accent-foreground` |
| `#C5BAFE` | 用户发出的对话背景 / 代码高亮字段 | `--accent` |

> **`--primary` 不是品牌紫。** 规范给 `#5D36DC` 的使用场景只有选中态与强调，不含主按钮；
> 主色调组里带「按钮」的那一行是近黑的 `#101319`（设计稿里 logo 方块和「新建智能体」主按钮都用它）。
> 因此 `--primary` 取 `#101319`（与 `.dark` 下 `--primary` 已有的中性取值一致），品牌紫只通过 `--brand` 使用。
> `#101319` 同时出现在黑灰色与主色调两组，取值相同，代码侧不重复建 Token。

### 功能色

| 色值 | 使用场景（设计侧） | CSS 变量 |
| --- | --- | --- |
| `#2D53FE` | 通知 | `--info` |
| `#F6FFED` | 提示框底色 | 暂无，见 [§3](#3-规范已定义但代码尚未落地) |
| `#B7EB8F` | 提示框边框色 | 暂无，见 [§3](#3-规范已定义但代码尚未落地) |
| `#1BB618` | 在线 / 成功 | `--success` |
| `#AFBCCB` | 掉线 | `--offline` |
| `#F15341` | 未读消息 / 失败 / 警报 / 删除 | `--destructive`（填充 / 描边 / 图标）、`--destructive-text`（文字，见下） |

> **这个色拆成了填充色和文字色两个 Token。** `#F15341` 直接做小号正文色对比度不达标：
> 白底上 **3.47:1**、`bg-destructive/10` 的同色浅底上 **3.08:1**，都低于 WCAG AA 对正常字号正文要求的 4.5:1。
> 而 `.agents/skills/design-taste-frontend/SKILL.md` 把「错误文案通过 WCAG AA」列为强制项，
> 也明确禁止回退既有的对比度，所以不能直接拿规范值给文字用。
>
> - `--destructive` = `#F15341`，规范原值，用于填充、描边、图标、状态点、`bg-destructive/10` 之类的底色。这些用途 3:1 即可，规范值达标。
> - `--destructive-text` = `color-mix(in oklch, var(--destructive), black 18%)`，解析为 `#B93E30`，用于文字：
>   `role="alert"` 的错误文案、`button.tsx` 的 `destructive` variant、`dropdown-menu.tsx` 的删除项、错误日志行。
>   白底 **5.53:1**、`bg-destructive/10` 上 **4.89:1**，达标（浏览器内实测，非估算）。
>
> 顺带修掉了一个既有问题：代码此前自定的 `#DC2626` 白底上是 4.83:1，但在 `bg-destructive/10` 的浅底上只有
> **4.12:1**，本来就没过 AA。拆分之后两种底色都达标。
>
> 用 `color-mix` 而不是写死十六进制，是为了规范改动 `#F15341` 时文字色自动跟随（同 `--secondary-hover` 的做法）。
> **待设计确认**：规范里 `#F15341` 是否真的会用于正文字号的文字。若设计侧确认它只做角标、圆点和浅底按钮，
> 那 `--destructive-text` 就该由规范补一个正式的深色文字值来取代；若设计侧接受当前推导值，把它补进规范即可。
> 暗色下不需要压深，`--destructive-text` 直接等于 `--destructive`（`#F97B69` 在暗底上最低也有 4.75:1，出现在 `bg-destructive/20` 的按钮底色上）。

## 3. 规范已定义但代码尚未落地

以下取值规范里有、代码里还没有对应 Token，因为暂时没有使用它们的组件。落地相关组件时按 [§5](#5-维护约定) 先补 Token 再使用：

- **提示框底色 / 边框色**：`#F6FFED`、`#B7EB8F`。设计稿里用于「周报发送成功」「归档成功」一类的成功提示框，
  代码目前没有提示框（toast / alert）组件。
- **未读消息**：`#F15341` 的「未读消息」用途。代码目前没有未读计数或红点 UI。

## 4. 代码侧的扩展

以下 Token 存在于代码中但**不在**当前 Figma 规范内，属于工程实现补齐的部分。设计侧补充规范后需回来对齐：

- **暗色模式**：`styles.css` 中 `.dark` 的全部取值。规范目前只定义了亮色。
  其中品牌色与功能色按同色相提亮、降饱和的方式从亮色推导（例如 `--destructive` 亮色 `#F15341` → 暗色 `#F97B69`）；
  中性色（`--background`、`--foreground`、`--primary` 等）是明暗对调，不走这条推导。
- **侧边导航**：`--sidebar`、`--sidebar-background`、`--sidebar-accent` 等（含渐变背景）。
- **中性底色**：`--background`、`--card`、`--popover`（`#ffffff`）与 `--primary-foreground`、`--brand-foreground`（`#ffffff`）。
- **危险态文字**：`--destructive-text`。规范只给了一个 `#F15341`，没有区分填充与文字；这个 Token 是为满足
  WCAG AA 正文对比度补的，取值由 `--destructive` 推导。设计侧补充文字用色后回来对齐。
- **中性 hover**：`--secondary-hover`，由 `--secondary` 混入 5% `--foreground` 推导，明暗主题各自解析。
- **终端/命令块**：`--terminal`、`--terminal-foreground`。明暗两种主题下都保持深色，取值同 `.dark` 的 `--card` / `--foreground`。
- **头像占位色**：`--avatar-1` ~ `--avatar-6`。设计稿用的是真实头像图，这六个色只服务于占位数据。

## 5. 维护约定

- 规范画板更新后，先改本文的映射表，再改 `styles.css`，保证两边可对照。
- 新增颜色一律先落到 `:root` 变量再使用，组件中不写死十六进制色值，也不写 `bg-[...]` 之类的任意值。
- 同一语义只用一个 Token 名。`--secondary` 与 `--muted` 目前取值相同，中性 hover 统一用 `hover:bg-muted`，
  按钮的 `secondary` variant 用 `hover:bg-secondary-hover`。
- 亮色取值以 Figma 为准；本文若与画板不一致，以画板为准并更新本文。
