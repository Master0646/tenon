---
schema_version: 1
title: 用户管理
verified_commit: "45c12ed"
sources:
  - path: frontend/src/views/UserList.vue
  - path: frontend/src/views/UserDetail.vue
  - path: frontend/src/api/user.js
  - path: backend/src/main/java/com/example/admin/user/UserController.java
    symbol: UserController
  - path: backend/src/main/java/com/example/admin/user/UserService.java
    symbol: UserService
  - path: backend/src/main/java/com/example/admin/user/UserMapper.java
    symbol: UserMapper
  - path: backend/src/main/resources/mapper/UserMapper.xml
  - path: backend/src/main/java/com/example/admin/user/User.java
    symbol: User
  - path: backend/src/main/java/com/example/admin/common/PageResult.java
    symbol: PageResult
  - path: backend/src/main/resources/schema.sql
  - path: backend/src/test/java/com/example/admin/user/UserServiceTest.java
related_specs: []
---

# 用户管理

## 职责
用户分页列表（关键字搜索）、用户详情、禁用用户。

## 调用链
- 列表：`frontend/src/views/UserList.vue`（`load`）→ `frontend/src/api/user.js`（`fetchUsers`，GET `/users`）→ `UserController#list`（GET `/api/users`）→ `UserService#list` → `UserMapper#selectPage` + `UserMapper#count`（`backend/src/main/resources/mapper/UserMapper.xml`）→ 表 `users` LEFT JOIN `roles`。
- 详情：`frontend/src/views/UserDetail.vue` → `fetchUser`（GET `/users/{id}`）→ `UserController#detail` → `UserService#get` → `UserMapper#selectById`。
- 禁用：`UserList.vue`（`onDisable`）→ `disableUser`（POST `/users/{id}/disable`）→ `UserController#disable`（从请求属性 `currentUserId` 取操作人）→ `UserService#disable` → `UserMapper#updateStatus`。

## 关键规则
- 列表参数：`keyword` 可选，`page` 默认 1，`size` 默认 20（`UserController#list`）。
- `size` 被限制在 1~100（`MAX_PAGE_SIZE = 100`），`page` 小于 1 按 1 处理（`UserService#list`）。
- 关键字对 `username`、`email` 做 `LIKE '%keyword%'` 模糊匹配，空串视为不过滤；按 `created_at` 倒序（`UserMapper.xml` 的 `selectPage`、`count`）。
- 返回 `PageResult { items, total }`（`PageResult`）。
- 用户不存在 → 404 "用户不存在"（`UserService#get`）。
- 禁用规则（`UserService#disable`），按以下顺序校验：
  - 操作者（`UserMapper#selectById(operatorId)`，每次请求实时查询）不存在或角色名不是 `ADMIN`（常量 `UserService.ADMIN_ROLE`）→ 403 "仅管理员可以禁用用户"；此项最先校验，非 ADMIN 无论目标是否存在都得到 403，见 [禁用用户需要 ADMIN 角色，前端对非 ADMIN 隐藏禁用按钮](../../changes/archive/2026-11-06-admin-only-disable/design.md)；
  - 不能禁用自己 → 400 "不能禁用当前登录的用户"；
  - 目标用户不存在 → 404；
  - 角色名为 `ADMIN` → 403 "不能禁用管理员"；
  - 否则把 `status` 更新为 `DISABLED`。
- 用户状态取值 `ACTIVE`、`DISABLED`（`User.Status`）；`roleName` 来自关联 `roles.name`（`User`、`UserMapper.xml` 的 `columns`）。
- 前端列表每页 20 条；仅当当前用户是 ADMIN（`isAdmin`）且该行 `status === 'ACTIVE'`、`roleName !== 'ADMIN'` 时显示"禁用"按钮，点击前二次确认（`UserList.vue`）。
- `isAdmin` 来自 `onMounted` 中的 `loadCurrentUser`（GET `/api/auth/me`，见 [登录与鉴权](auth.md)），与列表加载并行；未返回或请求失败时 `currentUser` 为 `null`，按钮不显示，失败不弹提示（`UserList.vue#loadCurrentUser`）。
- 单元测试 `UserServiceTest` mock `UserMapper`，覆盖上述禁用规则（`backend/src/test/java/com/example/admin/user/UserServiceTest.java`）。

## 配置与依赖
无独立配置；依赖登录鉴权提供的 `currentUserId`（见 [登录与鉴权](auth.md)）。

## 已知限制
- 列表和详情直接返回 `User` 实体，`User` 有 `getPasswordHash` 且无序列化排除注解，响应中会包含 `passwordHash` 字段（`User`、`UserController#list`、`UserController#detail`）。
- 没有启用（恢复 ACTIVE）、新增、编辑、删除用户的接口（`UserController`）。
- 对已是 `DISABLED` 的用户再次禁用不会报错（`UserService#disable`）。
- `UserList.vue#onDisable` 中 `ElMessageBox.confirm` 在 try 之外，取消确认时 Promise reject 未被捕获（`frontend/src/views/UserList.vue`）。
