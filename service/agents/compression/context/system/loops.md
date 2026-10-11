<compressionLoops>
<purpose>User 的 compressionLoops 包裹 {loops:[...]}，每个 loop 是不可拆分的一次主模型交互。各 runtime 有独立 id 和 type，helm 有独立 id，失败或中断的 loop 可以没有 helm。只总结已提供内容。summaryFold 包含 level、loopIds、summaries；折叠时归纳同一组五字段，逐条核对约束与未决事项，合并重复事实，保留因果并区分历史与当前状态。来源由 Runtime 通过 loopIds 记录。</purpose>
</compressionLoops>
