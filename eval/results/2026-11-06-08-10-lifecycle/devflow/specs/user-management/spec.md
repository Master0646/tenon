# user-management

## Purpose

用户管理：用户列表、详情查询，以及管理员禁用用户。

## Requirements

### Requirement: 禁用用户需要 ADMIN 角色
系统 SHALL 只允许角色为 ADMIN 的已登录用户调用 `POST /api/users/{id}/disable`。操作者角色 MUST 在每次请求时按其当前角色判定。非 ADMIN 操作者调用时，系统 MUST 返回 HTTP 403（响应体 `code` 为 403），且 MUST NOT 修改任何用户的状态。角色校验 MUST 先于其他禁用校验执行，使非 ADMIN 操作者无论目标用户是否存在都得到 403。

#### Scenario: 普通用户禁用他人
- WHEN USER 角色的已登录用户调用 POST /api/users/{id}/disable，目标为另一名 ACTIVE 的 USER
- THEN 返回 403，目标用户状态仍为 ACTIVE

#### Scenario: 普通用户禁用不存在的用户
- WHEN USER 角色的已登录用户调用 POST /api/users/{id}/disable，id 不存在
- THEN 返回 403，而不是 404

#### Scenario: 操作者记录不存在
- WHEN token 有效但对应的用户记录已不存在，调用 POST /api/users/{id}/disable
- THEN 返回 403，目标用户状态不变

#### Scenario: 管理员禁用普通用户
- WHEN ADMIN 角色的已登录用户调用 POST /api/users/{id}/disable，目标为 ACTIVE 的 USER
- THEN 返回成功，目标用户状态变为 DISABLED

### Requirement: 禁用用户的目标约束
ADMIN 操作者禁用用户时，系统 SHALL 拒绝禁用自己（返回 400），SHALL 拒绝禁用不存在的用户（返回 404），SHALL 拒绝禁用 ADMIN 角色的用户（返回 403）；被拒绝时 MUST NOT 修改用户状态。

#### Scenario: 管理员禁用自己
- WHEN ADMIN 调用 POST /api/users/{id}/disable，id 为自己的用户 ID
- THEN 返回 400，状态不变

#### Scenario: 管理员禁用另一名管理员
- WHEN ADMIN 调用 POST /api/users/{id}/disable，目标用户角色为 ADMIN
- THEN 返回 403，目标状态不变

#### Scenario: 管理员禁用不存在的用户
- WHEN ADMIN 调用 POST /api/users/{id}/disable，id 不存在
- THEN 返回 404

### Requirement: 被禁用的用户不能登录
系统 SHALL 拒绝状态为 DISABLED 的用户登录，返回 403，且 MUST NOT 签发 token。

#### Scenario: 被禁用用户登录
- WHEN 状态为 DISABLED 的用户以正确的用户名和密码调用 POST /api/auth/login
- THEN 返回 403，响应中没有 token

### Requirement: 查询当前登录用户
系统 SHALL 提供 `GET /api/auth/me`，向已登录用户返回其 id、用户名和角色名。响应 MUST NOT 包含密码哈希。未登录或 token 无效时 MUST 返回 401。

#### Scenario: 已登录用户查询自己
- WHEN 已登录的 USER 调用 GET /api/auth/me
- THEN 返回其 id、username，roleName 为 USER，响应中没有 passwordHash 字段

#### Scenario: 未登录查询
- WHEN 不带有效 token 调用 GET /api/auth/me
- THEN 返回 401

### Requirement: 前端只向 ADMIN 显示禁用按钮
用户列表页 SHALL 只在当前登录用户角色为 ADMIN 时显示"禁用"按钮；对 ADMIN，按钮 SHALL 仍只出现在状态为 ACTIVE 且角色不是 ADMIN 的行上。当前用户信息尚未获取或获取失败时，页面 MUST NOT 显示"禁用"按钮。

#### Scenario: 普通用户浏览用户列表
- WHEN USER 角色的用户打开用户列表页
- THEN 所有行都不显示"禁用"按钮

#### Scenario: 管理员浏览用户列表
- WHEN ADMIN 角色的用户打开用户列表页
- THEN ACTIVE 且非 ADMIN 的行显示"禁用"按钮，其余行不显示

#### Scenario: 获取当前用户失败
- WHEN 用户列表页请求 GET /api/auth/me 失败
- THEN 所有行都不显示"禁用"按钮
