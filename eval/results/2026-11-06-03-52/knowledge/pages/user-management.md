---
schema_version: 1
title: 用户管理
verified_commit: d1fae38
sources:
  - path: frontend/src/views/UserList.vue
  - path: frontend/src/views/UserDetail.vue
  - path: frontend/src/api/user.js
  - path: frontend/src/router/index.js
  - path: backend/src/main/java/com/example/admin/user/UserController.java
    symbol: UserController
  - path: backend/src/main/java/com/example/admin/user/UserService.java
    symbol: UserService
  - path: backend/src/main/java/com/example/admin/user/UserMapper.java
    symbol: UserMapper
  - path: backend/src/main/java/com/example/admin/user/User.java
    symbol: User
  - path: backend/src/main/resources/mapper/UserMapper.xml
  - path: backend/src/main/java/com/example/admin/role/RoleMapper.java
    symbol: RoleMapper
  - path: backend/src/main/java/com/example/admin/role/Role.java
    symbol: Role
  - path: backend/src/main/resources/schema.sql
related_specs: []
---

# 用户管理

## 职责
分页查询用户（按用户名或邮箱模糊搜索）、查看用户详情、禁用用户。角色只作为用户的关联属性展示，没有独立的角色管理接口。

## 调用链

**用户列表**
`/users` 路由（`frontend/src/router/index.js:7`）→ `UserList.vue#load`（`frontend/src/views/UserList.vue:39`）→ `fetchUsers`（`frontend/src/api/user.js:3`，`GET /api/users`）→ `UserController#list`（`backend/src/main/java/com/example/admin/user/UserController.java:24`）→ `UserService#list`（`backend/src/main/java/com/example/admin/user/UserService.java:18`）→ `UserMapper#selectPage` + `UserMapper#count` → `UserMapper.xml` 的 `selectPage` / `count`（`backend/src/main/resources/mapper/UserMapper.xml:9`、`:22`）→ 表 `users` LEFT JOIN `roles`。

**用户详情**
`/users/:id` 路由（`frontend/src/router/index.js:8`，`props: true`）→ `UserDetail.vue` 的 `onMounted`（`frontend/src/views/UserDetail.vue:18`）→ `fetchUser`（`frontend/src/api/user.js:4`，`GET /api/users/{id}`）→ `UserController#detail`（`UserController.java:32`）→ `UserService#get`（`UserService.java:24`）→ `UserMapper#selectById` → `UserMapper.xml` 的 `selectById`（`UserMapper.xml:31`）。

**禁用用户**
`UserList.vue#onDisable`（`UserList.vue:51`，先弹 `ElMessageBox.confirm`）→ `disableUser`（`frontend/src/api/user.js:5`，`POST /api/users/{id}/disable`）→ `UserController#disable`（`UserController.java:37`，操作人 ID 取自请求属性 `TokenService.USER_ID_ATTR`）→ `UserService#disable`（`UserService.java:33`）→ `UserMapper#updateStatus` → `UserMapper.xml` 的 `updateStatus`（`UserMapper.xml:43`）。

## 关键规则
- 分页参数默认值：`page=1`、`size=20`；`keyword` 可选（`UserController#list`，`UserController.java:25-27`）。
- `size` 被限制在 1 到 `MAX_PAGE_SIZE`=100 之间，`page` 小于 1 时按 1 处理（`UserService#list`，`UserService.java:10,19-20`）。
- 搜索：`keyword` 非空时对 `username` 或 `email` 做 `LIKE '%keyword%'`；结果按 `created_at` 倒序（`UserMapper.xml:14-18`）。
- 列表返回 `PageResult(items, total)`（`backend/src/main/java/com/example/admin/common/PageResult.java:5`）。前端固定每页 20 条（`UserList.vue:32`）。
- 用户不存在时抛 `BusinessException(404, "用户不存在")`（`UserService#get`，`UserService.java:26-28`）。
- 禁用规则（`UserService#disable`）：
  - 不能禁用自己，返回 400“不能禁用当前登录的用户”（`UserService.java:34-36`）；
  - 不能禁用 `roleName` 为 `ADMIN` 的用户，返回 403“不能禁用管理员”（`UserService.java:38-40`）；
  - 目标用户不存在时返回 404（经 `UserService#get`，`UserService.java:37`）；
  - 通过后把 `status` 改为 `DISABLED`（`UserService.java:41`）。
- 前端只在 `status === 'ACTIVE'` 且 `roleName !== 'ADMIN'` 时显示“禁用”按钮（`UserList.vue:13`）；后端独立校验 ADMIN 规则，但前端不隐藏当前登录用户自己的禁用按钮。
- 用户状态取值：`ACTIVE`、`DISABLED`（`User.Status`，`backend/src/main/java/com/example/admin/user/User.java:6`）；表默认值 `ACTIVE`（`backend/src/main/resources/schema.sql:12`）。
- 角色取值：`ADMIN`、`USER`，由 `schema.sql` 初始化插入（`schema.sql:3,18`；`Role#name` 注释，`backend/src/main/java/com/example/admin/role/Role.java:5`）。
- `roleName` 由 SQL 关联 `roles.name AS role_name` 得到（`UserMapper.xml:6`；`User.java:14`），依赖 `map-underscore-to-camel-case: true`（`backend/src/main/resources/application.yml:13`）。

## 数据表
- `users`：`id`、`username`（唯一）、`email`、`password_hash`（BCrypt）、`status`、`role_id`（外键 → `roles.id`）、`created_at`（`schema.sql:7-16`）。
- `roles`：`id`、`name`（唯一）、`description`（`schema.sql:1-5`）。

## 配置与依赖
- 所有 `/api/users/**` 接口都需要登录，由 `AuthInterceptor` 校验，见 [认证与会话](auth.md)。
- Mapper XML 位置 `classpath:mapper/*.xml`（`application.yml:11`）；Mapper 扫描包 `com.example.admin`（`backend/src/main/java/com/example/admin/AdminApplication.java:8`）。

## 已知限制
- `User` 含 `passwordHash` 字段且有 getter，未见忽略序列化的注解（`User.java:11,23`）；列表与详情接口直接返回 `User`（`UserController.java:24,32`），因此响应中会包含密码哈希（未核实运行时 JSON，仅依据代码）。
- 禁用不会使该用户已签发的 token 失效：`TokenService` 没有撤销方法，`AuthInterceptor` 不检查用户状态（`backend/src/main/java/com/example/admin/auth/TokenService.java`、`backend/src/main/java/com/example/admin/auth/AuthInterceptor.java:18-28`）。
- 没有启用（恢复 `ACTIVE`）、新增、编辑、删除用户的接口（`UserController.java`）。
- `RoleMapper#selectAll`（`backend/src/main/java/com/example/admin/role/RoleMapper.java:9-10`）在代码中没有调用方。
- 详情页把 `status`、`createdAt` 原样显示，无格式化或中文映射（`UserDetail.vue:5-6`）。
