---
schema_version: 1
title: 用户管理
verified_commit: 5da090b
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
  - path: backend/src/main/java/com/example/admin/role/Role.java
    symbol: Role
  - path: backend/src/main/java/com/example/admin/role/RoleMapper.java
    symbol: RoleMapper#selectAll
  - path: backend/src/main/resources/schema.sql
  - path: backend/src/main/java/com/example/admin/common/PageResult.java
    symbol: PageResult
related_specs: []
---

# 用户管理

## 职责
用户分页列表（按关键字搜索）、用户详情、禁用用户。角色只有 `ADMIN` / `USER` 两种，随用户查询一并带出角色名。

## 调用链
- 列表：`frontend/src/views/UserList.vue`（`load`）→ `frontend/src/api/user.js#fetchUsers`（`GET /users`）→ `UserController#list`（`GET /api/users`）→ `UserService#list` → `UserMapper#selectPage` + `UserMapper#count`（`backend/src/main/resources/mapper/UserMapper.xml`）→ 表 `users` 左连 `roles`。
- 详情：`frontend/src/views/UserDetail.vue` → `frontend/src/api/user.js#fetchUser`（`GET /users/{id}`）→ `UserController#detail` → `UserService#get` → `UserMapper#selectById`。
- 禁用：`UserList.vue`（`onDisable`，先 `ElMessageBox.confirm`）→ `frontend/src/api/user.js#disableUser`（`POST /users/{id}/disable`）→ `UserController#disable`（操作人 ID 取自请求属性 `TokenService.USER_ID_ATTR`，见 [认证与登录](auth.md)）→ `UserService#disable` → `UserMapper#updateStatus`。
- 前端路由：`/` 重定向到 `/users`；`/users` → `UserList.vue`；`/users/:id` → `UserDetail.vue`（`props: true`）（`frontend/src/router/index.js`）。

## 关键规则
- 分页参数：`page` 默认 1，`size` 默认 20（`UserController#list`）；`size` 被限制在 `[1, MAX_PAGE_SIZE]`，`MAX_PAGE_SIZE = 100`；`page` 小于 1 按 1 处理（`UserService#list`）。
- 关键字 `keyword` 非空时，对 `username` 或 `email` 做 `LIKE '%keyword%'` 模糊匹配；结果按 `created_at DESC` 排序（`UserMapper.xml#selectPage`、`UserMapper.xml#count`）。
- 列表返回 `PageResult { items, total }`（`PageResult`）。
- 详情：用户不存在时 404 "用户不存在"（`UserService#get`）。
- 禁用规则（`UserService#disable`）：
  - 不能禁用自己：400 "不能禁用当前登录的用户"；
  - 目标用户不存在：404（复用 `UserService#get`）；
  - 不能禁用 `ADMIN` 角色用户：403 "不能禁用管理员"；
  - 通过后把 `status` 置为 `DISABLED`。
- 用户状态枚举 `ACTIVE` / `DISABLED`（`User.Status`）；表默认 `ACTIVE`（`backend/src/main/resources/schema.sql`）。
- 前端仅在 `status === 'ACTIVE'` 且 `roleName !== 'ADMIN'` 时显示"禁用"按钮（`UserList.vue`）；前端每页固定 20 条（`UserList.vue` 的 `pageSize`）。
- 表结构（`backend/src/main/resources/schema.sql`）：
  - `roles`：`id`、`name`（唯一，`ADMIN` 或 `USER`）、`description`；初始化插入 `ADMIN`（管理员）、`USER`（普通用户）。
  - `users`：`id`、`username`（唯一）、`email`、`password_hash`（BCrypt）、`status`、`role_id`（外键 `roles.id`）、`created_at`（默认当前时间）。
- `User.roleName` 不是表列，由 `UserMapper.xml` 的 `columns` 片段 `r.name AS role_name` 关联得到（`User`）。

## 配置与依赖
- Mapper XML 位置与下划线转驼峰配置见 [项目基础设施](infrastructure.md)。

## 已知限制
- 没有新增、编辑、删除、启用（解除禁用）用户的接口（`UserController`）。
- `RoleMapper#selectAll` 已定义，但代码中没有任何调用方；也没有角色相关接口。
- 列表与详情直接返回 `User` 实体，其中含 `passwordHash` 字段且未做排除，会随 JSON 返回给前端（`User`、`UserController#list`、`UserController#detail`）。
- `count` 查询未关联 `roles`，与 `selectPage` 的过滤条件一致但写了两份（`UserMapper.xml`）。
- 详情页 `UserDetail.vue` 没有错误处理，用户不存在时页面空白（只显示"返回列表"）。
