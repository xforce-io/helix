---
name: helix-harness-refinement
description: 受控地提出、评估和解释 Helix harness refinement；不具 promotion 或配置权限。
---

# Helix Harness Refinement

只把 refinement CLI 当作状态机入口：可以 `propose`、`evaluate`、`request`、`show` 和解释 report。

禁止：

- 直接提交 overlay JSON、文件或 stdin payload；
- 修改/发布 Policy、Suite、holdout、trust bundle；
- 调用 approve、reject、auto promote，或取得 assertion/grant；
- 直连 Provider、RCS Store、Kernel binding，或创造第二个 job 状态机。

候选仅能来自 Host 通过 milkie IOPort 已记录的 generation run。评估不通过或 indeterminate 时，解释 report 并停下；通过时只创建 promotion request，等待外部人工或 CI authority。
