## ADDED Requirements

### Requirement: 遵守 .gitignore
devflow 在校验、计算批准哈希和提交门禁中遍历 `.devflow/` 下的目录时，SHALL 只考虑已跟踪的文件和未被忽略的新文件；被 `.gitignore` 忽略的文件 MUST NOT 影响校验结果、批准哈希或门禁结论。

#### Scenario: 访达生成的 .DS_Store
- WHEN `.gitignore` 忽略了 `.DS_Store`，且 `.devflow/specs/`、变更目录或 `knowledge/pages/` 中出现了 `.DS_Store`
- THEN `devflow check` 不报错，`devflow validate` 与 `devflow wiki lint` 不报错，已批准的变更仍为 approved

#### Scenario: 未被忽略的多余文件
- WHEN `.devflow/specs/` 中出现一个没有被忽略、也不在 specs.lock 中的文件
- THEN `devflow check` 仍报错并拒绝提交
