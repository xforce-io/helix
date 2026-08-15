# P3 refinement fixtures

这些文件是 Factorio example 的可重复 HMAC fixture：`policy.fixture.json` 和
`suite.fixture.json` 只能由 `FACTORIO_REFINEMENT_FIXTURE` 对应的 HRCA key 发布；
`createFactorioFixtureAssertion()` 只为测试签发 scoped actor assertion。

它们不是生产凭证、不是模型上下文，也不授予模型 mint 或 promote 权限。真实部署应以
部署 IdP/mTLS 替换 fixture verifier，并把签发密钥放在仓库与 RCS 之外。CLI Host 只读取
`ANTHROPIC_MODEL`；每次真实 P3 运行都须在同一个 `artifacts/factorio/harness-state` 中
发布可信 policy/suite，再以人类 assertion 执行 propose、evaluate、request 与 promote。

`policy.fixture.json` 故意 pin 到 `fixture-recorded-model`，只可搭配注入的 fixture Host。
真实 Factorio Host 会拒绝与 `ANTHROPIC_MODEL` 不一致的 policy，避免 policy 声明与实际
模型调用发生漂移。
