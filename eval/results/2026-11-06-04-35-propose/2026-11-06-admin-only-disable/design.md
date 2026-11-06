# 设计

## 现状

```flow LR
UserList.vue -> AuthInterceptor -> UserController#disable -> UserService#disable -> UserMapper#updateStatus
```

- `AuthInterceptor#preHandle` 只校验 token，把用户 ID 写入请求属性 `currentUserId`。
- `UserController#disable` 用 `@RequestAttribute(TokenService.USER_ID_ATTR)` 拿到 `operatorId` 并传给 `UserService#disable`。
- `UserService#disable` 依次检查：禁用自己 → 400；目标不存在 → 404；目标是 ADMIN → 403。没有操作者角色检查。
- `UserMapper#selectById` 已关联 `roles` 表返回 `roleName`，可直接用于判断操作者角色。

## 后端：禁用接口角色校验

在 `UserService#disable` 开头增加操作者角色校验，其余逻辑不变：

```flow TB
开始 -> 查询操作者 selectById(operatorId)
查询操作者 selectById(operatorId) -> 操作者存在且 roleName == ADMIN?
操作者存在且 roleName == ADMIN? -> 否: 抛 BusinessException(403, 仅管理员可以禁用用户)
操作者存在且 roleName == ADMIN? -> 是: 原有校验(自己 400 / 不存在 404 / ADMIN 403)
是: 原有校验(自己 400 / 不存在 404 / ADMIN 403) -> updateStatus(DISABLED)
```

- 放在 Service 层而不是拦截器：只有这一个接口需要角色约束，Service 层已有 `operatorId` 和 `UserMapper`，改动最小，也便于单元测试。
- 角色字符串 `"ADMIN"` 在 `UserService` 中已出现一次，抽成类内常量 `ADMIN_ROLE` 复用。
- 错误通过已有的 `BusinessException` 抛出，`GlobalExceptionHandler#business` 会把 HTTP 状态码设为 403。

```sequence
前端 -> 后端: POST /api/users/5/disable (USER 的 token)
后端 -> 数据库: selectById(操作者)
数据库 --> 后端: roleName = USER
后端 --> 前端: 403 {code: 403, message: 仅管理员可以禁用用户}
```

## 后端：GET /api/auth/me

- 在 `LoginController` 增加 `GET /me`，参数 `@RequestAttribute(TokenService.USER_ID_ATTR) Long userId`。`WebConfig` 只排除了 `/api/auth/login`，所以 `/api/auth/me` 自动受拦截器保护，未登录返回 401。
- 在 `AuthService` 增加 `currentUser(Long userId)`：用 `UserMapper#selectById` 查询，为空时抛 `BusinessException(401, "登录已失效")`（前端已有 401 跳登录页的处理）。
- 返回 `LoginController` 内的 record `CurrentUser(Long id, String username, String roleName)`，不复用 `User` 实体，避免带出 `passwordHash`。

```sequence
前端 -> 后端: GET /api/auth/me
后端 -> 数据库: selectById(currentUserId)
数据库 --> 后端: User
后端 --> 前端: {id, username, roleName}
```

## 前端

- `frontend/src/api/user.js` 增加 `fetchCurrentUser = () => request.get('/auth/me')`。
- `UserList.vue`：
  - 新增 `currentUser = ref(null)`，`isAdmin = computed(() => currentUser.value?.roleName === 'ADMIN')`。
  - `onMounted` 中并行请求当前用户与列表；获取当前用户失败时保持 `null`（不弹错误提示，列表照常显示）。
  - 禁用按钮条件改为 `isAdmin && row.status === 'ACTIVE' && row.roleName !== 'ADMIN'`。

```flow LR
UserList.vue#onMounted -> fetchCurrentUser -> GET /api/auth/me -> isAdmin
isAdmin -> 禁用按钮 v-if
```

## 测试

后端目前没有测试依赖。在 `backend/pom.xml` 加入 `spring-boot-starter-test`（test scope），用 JUnit 5 + Mockito 对 `UserService`、`AuthService` 做单元测试，mock `UserMapper`，不依赖数据库。

前端没有测试框架，本变更不引入；以 `npm run build` 通过和手工验证（分别用 ADMIN、USER 账号登录查看列表）作为验收。

## 兼容性

- USER 角色调用禁用接口由成功变为 403，是本变更的目的。
- 每次禁用多一次按主键查询，开销可忽略。
