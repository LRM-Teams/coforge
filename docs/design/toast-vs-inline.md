# 13. 反馈：toast 还是内联

这是主流设计系统的共识，不是本项目自创的规则：toast（本应用用 Sonner，经 `components/ui/toast.tsx` 的 `useAppToast` 使用）只确认用户刚做完的一个动作，不携带需要用户处理的错误。

- Shopify Polaris [Toast](https://polaris-react.shopify.com/components/internal-only/toast) — 动作之后的反馈；避免用 toast 呈现错误，需要持续存在的错误放在受影响区域自己的 [Banner](https://polaris.shopify.com/components/banner) 里。
- Atlassian [Messages 模式](https://atlassian.design/patterns/messages/)：只需要最小交互的确认用 [Flag](https://atlassian.design/components/flag)；需要用户处理或重要信息用 [Inline message](https://atlassian.design/components/inline-message)，放在受影响区域里。
- Material 3 [Snackbar 规范](https://m3.material.io/components/snackbar/guidelines)：一行文字，最多一个操作，打断最小，不要求用户操作，一次只显示一条。
- NN/g [错误提示指南](https://www.nngroup.com/articles/error-message-guidelines/)：只有最小交互成本的问题才适合用 toast/banner；用户必须看到或必须处理的错误留在页面内、持续显示。

CoForge 的应用：

- 用户必须看到、必须处理、或者导航离开再回来还要能找到的状态，一律内联显示在受影响的区域里：进行中状态带 spinner 并禁用控件、失败要给出原因和重试、离线的 Computer、字段校验。
- toast 最多是一行确认文字。
- 同一件事不能同时用两种方式呈现。
- 不显示原始错误码或线路字符串。
- 错误参考编号只能出现在内联失败说明下方的一行灰色小字里。

范例：Computer 升级（进行中内联显示；成功后内联更新版本号，另外配一条 toast；失败内联显示原因和重试按钮，不发 toast）与 Computer 重启（只用 toast，不留内联状态）。
