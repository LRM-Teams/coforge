# Memory 消费侧四层记账与 ACL-safe 聚合：自主监听检索、节流投递与索引级曝光隔离

Memory Hint 是 task/run-scoped 终端消费事件（Q106-A）：可综合多个 Fork/Branch/Guidance/Skill 来源，经 `memory@target_agent` 定向投递；不进检索索引、不作 explore 中转节点，仅沿 provenance 反向追溯。价值信号分四层（Q66-A/Q86-A/Q89-A）：`exposure` 由检索服务在 Hint 实际进入 agent 可见上下文时记录（0 utility）；`citation` 仅在 task agent 输出结构化 `{memory_ref, role=considered|applied|rejected|compared}` 时记录；`adoption` = citation(role=applied) + 后续 action 与 guidance 的版本化行为谓词匹配，由独立 extractor/服务端判定，agent 自报不成立；`outcome` = 真实任务成功/无纠错或配对 replay 相对基线改善。被 @ 的目标 agent 对每个已处理 Hint 输出结构化 `MemoryDisposition(decision=adopt|reject|defer)`，独占采纳决定；reject/defer 仍形成 citation，超时无回执只算 exposure；followthrough=observed|partial|not_observed|contradicted 与 outcome 独立记录，只有 adoption + followthrough + 正向 outcome 形成正向 outcome utility。

**双维引用强度与衰减**（Q68/Q70/Q73/Q78）：全部 citation events 发生时等权记录、永久保留；引用方与来源 task lineage 相同进 `in_task_reference_strength`，不同进 `cross_task_reference_strength`，两维不预压成全局标量；物化强度用 policy-versioned 指数衰减 `2^(-age/half_life)`，默认 in-task 7 天 / cross-task 90 天，策略变化重算投影不改事件。task_id 仅权威 task/evaluation orchestrator 可铸造、不可变（Q88-B/Q90-A）：replay/continuation/baseline/恢复 run 继承原 ID，新顶层任务实例即使文本相同也不按内容 hash 合并；ID 不同即 cross-task。

**探索与去偏**（Q87-A/Q91-A）：provisional 默认 4 槽 = 3 exploitation + 1 seeded exploration（从低曝光/高不确定候选中可复现选取，记录 eligible set、selection propensity、seed、policy version）；无合格探索候选回填 exploitation。原始 citation 继续等权记录；propensity 校正生成 policy-versioned `debiased_reference_signal`，仅用于离线评价与下一版 reranker，不即时回灌在线 policy。

**ACL-safe 聚合**（Q94-A）：citation/disposition/followthrough/outcome/judgment 事件冻结来源 task/channel 与主体安全标签；在线检索、引用强度、outcome、治理分只使用当前 principal 有权观察的事件，不返回隐藏事件数、task ID 或可反推小样本差值（排序变化本身也是侧信道）；服务端全量聚合仅用于受控离线评价，经阈值化/去标识产物进入新 policy。

**索引级曝光隔离（M4'）**：Influence 投影卡片命中进入 provisional 检索结果后，任务侧可能看见甚至结构化引用它；若不划界，索引命中会沿"被看见→被引用→排名上升"回流进 fork_node_id 聚合与 citation/utility 账本（Q66 防过的自证循环的索引版）。规则：投影命中只记**索引级 exposure**（仅供离线召回质量评估），不进入 citation、adoption、outcome、簇与 verified 通道；只有经过 grounding、成为 ForkRevision 或 Memory Hint 来源后，才进入因果账本。

**自主监听模式（Q116-B）**：非评测任务中 Memory Agent 作为群聊成员自主运行——每条频道消息都触发完整三段式检索（服务端预召回 + 主 Memory LLM explore），不设前置相关性过滤器、不设 workspace 父级预算上限（Q118-B/Q120-B），由 Memory Agent 自己判断何时停止（retrieval profile 的停止条件仍是硬约束），capability = 频道成员身份 ∩ 来源 session ACL。投递侧节流（Q119-A）：同一 task lineage 对同一 target agent 未决 Hint 上限默认 2、冷却窗口、同 provenance 去重（只刷新 TTL）；target agent 可声明偏好（defer-all、按类型过滤）；用户可要求静默；超时未处理只记 exposure。该组合的含义：检索侧完全自主、成本刹车只剩 profile 停止条件与投递节流——若活跃频道成本失控，应优先补外部预算门控而不是收回自主权。
