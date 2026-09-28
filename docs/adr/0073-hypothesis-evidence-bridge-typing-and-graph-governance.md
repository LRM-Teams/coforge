# 跨 lane 关联分型为 HypothesisBridge/EvidenceBridge，假设图以容量、失活与晋升治理约束全局膨胀

Memory 双 lane 检索（Interaction lane / Causal-memory lane）之间，模型可在任意两类节点间提出跨 lane 关联，但必须分型（Q67-A）：`HypothesisBridge` 表达"值得探索"，创建后即全局长期可遍历（Q71-B）、可供所有任务沿它多跳，但它只是探索导航；`EvidenceBridge` 由直接 provenance 或服务端验证的诊断提议产生，是唯一可支撑 fork 归因的跨 lane 关系。二者不得共用状态或边语义。

**路径硬边界**（Q72-A）：每条探索 path 最多跨 2 条 HypothesisBridge、最多 12 个实体、禁止重复节点/边；每个端点必须重新与原始 query/MemoryTaskState 做直接适用性检查；间接路径不得自动产生 verified similarity、citation 或 EvidenceBridge；统一 5 个 workers 共享总路径预算——`A~B、B~C` 不能推出 `A~C`。

**双通道召回**（Q74-A/Q79-A）：EvidenceBridge/权威 ForkRevision 进 verified 通道，HypothesisBridge/ForkCandidate 进 provisional 通道，独立配额（默认每次 12 个轻量候选：verified 8 / provisional 4，不足可回填但保留来源通道与通道内 rank）与内部排序后再带状态标签混合输出；hypothesis citation 只影响 provisional 通道内部排名，不能凭引用量压过 verified evidence。

**图治理**（Q75-A/Q80-A）：服务端验证 endpoint/type/ACL；按 canonical endpoint pair + relation type 聚合去重、保留每次 model judgment 事件；per-run 写入配额（每 evaluation iteration 最多 12 个 endpoint-pair hypothesis judgments）与 per-node active-edge cap（32）；超限时最低"直接相关性 × 时间衰减 × 引用强度"的边转 inactive——仅退出遍历索引，审计记录不删除。inactive 可再激活（Q83-A）：仅新 model judgment、明确含 bridge_id 的 citation、adoption/outcome 或 direct-relevance 重验触发治理分重算，重新进入节点 top-32 且 ACL 有效时恢复 active；exposure/traversal 不触发。

**晋升与排序**：citation/traversal 只能提高再诊断/验证优先级，不能自动晋升（Q76-A）；HypothesisBridge→EvidenceBridge 必须由 causal diagnosis 提交直接 evidence refs、关系语义与反例检查，走 propose→server validate；仅 citation provenance 明确包含 bridge_id 才给该桥计引用。通道内排序先过硬门槛（ACL、状态、freshness、直接适用性），再用 policy-versioned、role-specific reranker（Q84-A）：verified 侧以语义相关、evidence quality、outcome utility、新鲜度为主；provisional 侧以语义相关、直接适用性、judgment 一致性、衰减后双维引用强度为主；保存 feature breakdown 与确定性 tie-break。跨任务泛化能力继续记在已验证相似边 + 跨树簇的簇条件 branch_pattern 效用上（Q124-A 重申），不搬到影响图节点（否则图内路径会被读成跨任务相似、走私 #30 禁止的传递性，且 block 无跨任务稳定身份）。

默认参数（Q78-A）：citation 指数衰减 half-life in-task 7 天 / cross-task 90 天，版本化 policy 调整并重算投影；workspace 只能收紧 12/32 等全局安全上限。
