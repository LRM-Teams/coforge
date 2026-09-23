# 9. 字段展示：表单和长值用网格，短事实用列表

两种写法，按内容选一种。同一个 section 里不混用。

**字段网格：label 在上，value 在下。** 用于表单、可编辑字段、长值（路径、命令、URL）和字段很多的页面。表单也是这个方向（官方 Input 的 label 就在上方），读和写是同一套语法。

- label：`text-sm text-tertiary`，常规字重。value：`text-sm font-medium text-primary`。两者间距 4px。
- 多个字段排成网格：`md:grid-cols-2 xl:grid-cols-3`，`gap-x-8 gap-y-6`。长值独占一整行。
- 字段之间不画线。只在 section 之间画一条 `border-secondary`，section 内边距 `py-6 px-8`。
- 可编辑字段外观和只读字段一致。hover 出现浅底和铅笔，点击原地换成官方 Input 加 Save / Cancel，Escape 取消。不要常驻的编辑图标。

**事实列表：label 在左，value 在右。** 用于详情页上只读的短事实：不超过 8 条，每个值一行放得下。参照 macOS 系统设置的「关于本机」。范例：Computer 详情页。

- 一行一个事实。label：`text-sm font-medium text-primary`，不折行。value：`text-sm text-tertiary`，靠右，不在词中间折行。行高至少 44px，行间一条 `border-secondary`，最后一行后面不画。
- 语义用 `<dl>`，每行一个 `<div>` 包一对 `<dt>` / `<dd>`。
- 作用于某个事实的操作放在那一行的行尾：`size="sm"`、`color="secondary"` 的官方 Button，一行最多一个。进行中就是这个按钮的 loading 状态。
- 针对那个事实的说明或错误放在那一行主行的下面，占满整行，不和值、按钮横排。错误按[第 13 节](toast-vs-inline.md)：一句原因，下面一行灰色小字的参考编号。主行在任何状态下都保持单行、不变形。
- 窄容器里行尾操作折到值的下面，label 顶对齐。
- 作用于整个对象的操作（比如重启）不进列表，放页头右侧。
- 一组事实可以包在 `rounded-xl bg-secondary` 的浅底分组里，没有 border、没有阴影；分组标题 `text-sm font-semibold`，放在分组外、和行内文字左对齐。这是内容里的一组事实，不是[第 8 节](page-skeleton-and-density.md)禁止的页面级卡片岛屿。
- 详情页顶部可以用居中的身份区（大号对象图标带状态点，下面是名称）。只用于「某一个对象」的详情页，列表页和表单页不用。名称可以改时，铅笔常驻挂在名称右侧、不挤偏名称：居中的标题没有可以 hover 出浅底的字段框，触屏上也没有 hover。

两种写法共用：

- 标识符类的值（主机名、版本号、ID、路径）用 `font-mono`。
- 空值显示 `—`，不显示 "N/A"、"Unknown"、"暂无"。
- label 要在上下文里不产生歧义：「System」下面的版本号写「CoForge version」，不写「Version」。
