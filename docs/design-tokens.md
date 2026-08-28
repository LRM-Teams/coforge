# CoForge 设计 Token 规范

状态：与 Figma《Coforge UI 设计规范》同步

更新时间：2026-08-28

适用范围：`apps/web` 的颜色 Token（`apps/web/src/styles.css`）

## 1. 规范来源

设计侧唯一来源是 Figma 文件 *River 新版设计方案* 中的画板 **Coforge UI 设计规范**：

- 文件：<https://www.figma.com/design/B0tLPylcm6pLiNzz1JXQnC/>
- 画板节点：`2672:8421`（所在页面 `2672:6903`「2026.08.26 页面、规范与组件」）

该画板标注了「⚠️ 持续更新！」。**当前规范只包含 Color 一节**，尚无字体、间距、圆角、阴影等章节；本文同步范围与之一致，不自行补充设计侧尚未确定的内容。

## 2. 颜色 Token 映射

代码侧的 Token 定义在 `apps/web/src/styles.css` 的 `:root` 中，并通过 `@theme inline` 暴露为 Tailwind 的 `--color-*` 工具类。

### 黑灰色

| 色值 | 使用场景（设计侧） | CSS 变量 |
| --- | --- | --- |
| `#101319` | 标题 / 对话正文 / 未选中的导航名称 / 未选中的 icon | `--foreground`、`--card-foreground`、`--popover-foreground`、`--secondary-foreground`、`--sidebar-foreground` |
| `#777D8D` | 对话预览行 / tab 文字 | `--muted-foreground` |
| `#E0E5F1` | 投影 / 边框 / 分割线 | `--border`、`--input`、`--sidebar-border` |
| `#F4F6FA` ⚠️ | tab 背景 / 对话内容背景 / 对话选中背景 | `--secondary`、`--muted` |

> ⚠️ **规范表标注疑似笔误，待设计确认**：这一行的**文字标注写的是 `#F4FAF6`（偏绿）**，但**同一行的色块实际填充是 `#F4F6FA`（偏蓝）**，`FA` / `F6` 疑似写反。
> 设计稿页面上量到的是 `#F3F6FA`（「电脑」标签、数据标签、分段控件底色三处一致），与色块只差 1/255。
> 同组的 `#777D8D`、`#E0E5F1` 都是偏蓝的灰，`#F4FAF6` 是九个色里唯一偏绿的。
> **代码此前取的是笔误的标注值 `#F4FAF6`，现已按色块实际填充改为 `#F4F6FA`。**
> 若设计确认应为页面上的 `#F3F6FA`，只需再改 `--secondary` / `--muted` 两处。

### 主色调

| 色值 | 使用场景（设计侧） | CSS 变量 |
| --- | --- | --- |
| `#5D36DC` | 选中的导航名称 / 选中的 icon / 消息标签 / @用户名 | `--brand`、`--ring`、`--accent-foreground`、`--sidebar-accent-foreground` |
| `#C5BAFE` | 用户发出的对话背景 / 代码高亮字段 | `--accent` |

> **`--primary` 不是品牌紫。** 规范给 `#5D36DC` 的使用场景只有选中态与强调，不含主按钮；
> 设计稿里 logo 方块和「新建智能体」主按钮都是近黑的 `#101319`。因此 `--primary` 取 `#101319`
> （与 `.dark` 下 `--primary` 已有的中性取值一致），品牌紫只通过 `--brand` 使用。

### 功能色

| 色值 | 使用场景（设计侧） | CSS 变量 |
| --- | --- | --- |
| `#2D53FE` | 通知 | `--info` |
| `#1BB618` | 在线 / 成功 | `--success` |
| `#AFBCCB` | 掉线 | `--offline` |

## 3. 代码侧的扩展

以下 Token 存在于代码中但**不在**当前 Figma 规范内，属于工程实现补齐的部分。设计侧补充规范后需回来对齐：

- **暗色模式**：`styles.css` 中 `.dark` 的全部取值。规范目前只定义了亮色。
- **侧边导航**：`--sidebar`、`--sidebar-background`、`--sidebar-accent` 等（含渐变背景）。
- **危险态**：`--destructive`。规范的功能色只有通知、在线/成功、掉线三项。
- **中性底色**：`--background`、`--card`、`--popover`（`#ffffff`）与 `--primary-foreground`、`--brand-foreground`（`#ffffff`）。
- **中性 hover**：`--secondary-hover`，由 `--secondary` 混入 5% `--foreground` 推导，明暗主题各自解析。
- **终端/命令块**：`--terminal`、`--terminal-foreground`。明暗两种主题下都保持深色，取值同 `.dark` 的 `--card` / `--foreground`。
- **头像占位色**：`--avatar-1` ~ `--avatar-6`。设计稿用的是真实头像图，这六个色只服务于占位数据。

## 4. 维护约定

- 规范画板更新后，先改本文的映射表，再改 `styles.css`，保证两边可对照。
- 新增颜色一律先落到 `:root` 变量再使用，组件中不写死十六进制色值，也不写 `bg-[...]` 之类的任意值。
- 同一语义只用一个 Token 名。`--secondary` 与 `--muted` 目前取值相同，中性 hover 统一用 `hover:bg-muted`，
  按钮的 `secondary` variant 用 `hover:bg-secondary-hover`。
- 亮色取值以 Figma 为准；本文若与画板不一致，以画板为准并更新本文。
