# 提案

## 为什么

`POST /api/users/{id}/disable` 目前只要求登录：拦截器只校验 token（`backend/src/main/java/com/example/admin/auth/AuthInterceptor.java#preHandle`），`UserService#disable` 只检查"不能禁用自己"和"不能禁用 ADMIN"（`backend/src/main/java/com/example/admin/user/UserService.java:33-43`），不检查操作者的角色。结果是任何 USER 角色的普通用户都能禁用其他普通用户。

前端用户列表对所有登录用户都显示"禁用"按钮（`frontend/src/views/UserList.vue:12-15`），而前端目前拿不到当前登录用户的角色：登录接口只返回 token（`backend/src/main/java/com/example/admin/auth/LoginController.java#login`）。

## 改什么

1. **后端鉴权**：禁用接口只允许 ADMIN 角色的操作者调用；非 ADMIN 调用返回 403，目标用户状态不变。
2. **当前用户接口**：新增 `GET /api/auth/me`，返回当前登录用户的 id、用户名、角色名，供前端判断角色。
3. **前端**：用户列表页加载当前用户信息，非 ADMIN 用户看不到"禁用"按钮；ADMIN 看到的按钮规则与现在一致。
4. **规范补全**：当前 `.devflow/specs/` 为空。本变更新建 `user-management` 能力，把禁用接口的既有约束（不能禁用自己、不能禁用 ADMIN、被禁用用户不能登录）一并写入规范，这些行为不变。

## 影响

- 对外行为变化：USER 角色调用禁用接口，原来成功，现在返回 403。依赖普通用户执行禁用的使用方式会失效。
- 新增一个只读接口 `GET /api/auth/me`，需要登录。
- 后端引入 `spring-boot-starter-test`（test scope）以编写单元测试；不影响运行时依赖。
- 前端用户列表页多一次 `/api/auth/me` 请求。

## 不做什么

- 不引入 Spring Security 或通用的注解式权限框架；只在禁用接口上做角色校验。
- 不改列表、详情等其他接口的权限。
- 不处理已签发 token 的吊销：被禁用用户已持有的 token 在过期前仍可用（`TokenService` 现状，`backend/src/main/java/com/example/admin/auth/TokenService.java`）。
- 不处理 `User` 序列化时带出 `passwordHash` 的问题（`backend/src/main/java/com/example/admin/user/User.java`）；`/api/auth/me` 使用独立的返回结构，不返回该字段。该问题建议另提变更。
- 不新增"启用用户"功能。

## 假设

需求未说明的地方按以下理解：

1. **角色判断依据**：以数据库中操作者当前的角色名（`roles.name`）是否等于 `ADMIN` 为准，每次请求实时查询，不缓存在 token 中。这样角色调整后立即生效。
2. **校验顺序**：先校验操作者角色，再做"不能禁用自己""目标是否存在""不能禁用 ADMIN"等校验。非 ADMIN 无论目标是谁、是否存在，一律返回 403，避免通过错误码探测用户是否存在。
3. **错误响应**：HTTP 403，`code` 为 403，消息为"仅管理员可以禁用用户"，沿用现有 `BusinessException` + `GlobalExceptionHandler` 的格式。
4. **操作者记录不存在**（token 有效但用户已被删除）：按非 ADMIN 处理，返回 403。
5. **前端获取角色的方式**：新增 `GET /api/auth/me`，而不是在登录响应里带角色并存进 localStorage。理由：角色以服务端为准，不会因 localStorage 过期或被篡改而显示错误；前端隐藏按钮只是体验优化，真正的约束在后端。
6. **前端在获取当前用户失败或尚未返回时**：不显示禁用按钮（默认隐藏）。
7. **隐藏范围**：只涉及用户列表页的"禁用"按钮；用户详情页目前没有禁用按钮（`frontend/src/views/UserDetail.vue`），不改。
