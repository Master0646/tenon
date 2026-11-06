---
schema_version: 1
title: 登录与鉴权
verified_commit: "45c12ed"
sources:
  - path: backend/src/main/java/com/example/admin/auth/LoginController.java
    symbol: LoginController#login
  - path: backend/src/main/java/com/example/admin/auth/LoginController.java
    symbol: LoginController#me
  - path: backend/src/main/java/com/example/admin/auth/AuthService.java
    symbol: AuthService#login
  - path: backend/src/main/java/com/example/admin/auth/AuthService.java
    symbol: AuthService#currentUser
  - path: backend/src/main/java/com/example/admin/auth/TokenService.java
    symbol: TokenService
  - path: backend/src/main/java/com/example/admin/auth/AuthInterceptor.java
    symbol: AuthInterceptor#preHandle
  - path: backend/src/main/java/com/example/admin/auth/WebConfig.java
    symbol: WebConfig#addInterceptors
  - path: backend/src/main/java/com/example/admin/user/UserMapper.java
    symbol: UserMapper#selectByUsername
  - path: backend/src/main/java/com/example/admin/user/UserMapper.java
    symbol: UserMapper#selectById
  - path: backend/src/main/resources/mapper/UserMapper.xml
  - path: frontend/src/views/Login.vue
  - path: frontend/src/views/UserList.vue
  - path: frontend/src/api/user.js
  - path: frontend/src/api/request.js
  - path: frontend/src/router/index.js
  - path: backend/src/test/java/com/example/admin/auth/AuthServiceTest.java
related_specs: []
---

# 登录与鉴权

## 职责
用户名密码登录、签发内存 token，对 `/api/**` 请求校验 `Authorization: Bearer <token>`，并提供当前登录用户查询接口。

## 调用链
- 登录：`frontend/src/views/Login.vue`（`onSubmit`）→ `frontend/src/api/user.js`（`login`，POST `/auth/login`）→ `LoginController#login`（POST `/api/auth/login`）→ `AuthService#login` → `UserMapper#selectByUsername`（`backend/src/main/resources/mapper/UserMapper.xml` 的 `selectByUsername`，`users` LEFT JOIN `roles`）→ `TokenService#issue`。
- 鉴权：`frontend/src/api/request.js` 请求拦截器加 `Authorization: Bearer <token>` → `AuthInterceptor#preHandle` → `TokenService#verify` → 把用户 ID 写入请求属性 `currentUserId`（`TokenService.USER_ID_ATTR`）。
- 当前用户：`frontend/src/views/UserList.vue`（`loadCurrentUser`）→ `frontend/src/api/user.js`（`fetchCurrentUser`，GET `/auth/me`）→ `LoginController#me`（GET `/api/auth/me`，从请求属性 `currentUserId` 取用户 ID）→ `AuthService#currentUser` → `UserMapper#selectById`。

## 关键规则
- 登录请求体 `username`、`password` 均 `@NotBlank`（`LoginController.LoginRequest`）；成功返回 `{ token }`（`LoginController#login`）。
- `GET /api/auth/me` 返回 `{ id, username, roleName }`，结构为 `LoginController` 内的独立 record `CurrentUser`，不含 `passwordHash`（`LoginController.CurrentUser`、`LoginController#me`）；用户记录已不存在时 → 401 "登录已失效"（`AuthService#currentUser`）。该接口供前端判断角色，见 [禁用用户需要 ADMIN 角色，前端对非 ADMIN 隐藏禁用按钮](../../changes/archive/2026-11-06-admin-only-disable/design.md)。
- 用户不存在或 BCrypt 校验失败 → 401 "用户名或密码错误"；状态为 `DISABLED` → 403 "用户已被禁用"（`AuthService#login`）。
- token 为随机 UUID，有效期 2 小时，存在进程内 `ConcurrentHashMap`；服务重启后全部失效（`TokenService#issue`、`TokenService.TTL`）。
- token 缺失、不存在或过期时 `verify` 返回 null，拦截器直接返回 HTTP 401（无响应体）（`TokenService#verify`、`AuthInterceptor#preHandle`）。
- 拦截范围 `/api/**`，只排除 `/api/auth/login`，因此 `/api/auth/me` 需要登录（`WebConfig#addInterceptors`）。
- 前端 token 存在 `localStorage` 的 `ua_token`（`frontend/src/api/request.js`）。
- 前端收到 401 时清除 token 并跳转 `/login?redirect=<当前路径>`（`frontend/src/api/request.js` 响应拦截器）；路由守卫对非 `meta.public` 页面在无 token 时同样跳转（`frontend/src/router/index.js`）。
- 登录成功后跳转 `route.query.redirect`，缺省 `/users`（`Login.vue#onSubmit`）。

## 配置与依赖
- BCrypt 来自 `spring-security-crypto`，`AuthService` 中直接 `new BCryptPasswordEncoder()`（`AuthService`）。
- 无外部认证服务，token 不持久化（`TokenService`）。

## 已知限制
- 没有登出接口，过期 token 不会从 `sessions` 中删除（`TokenService`）。
- `TokenService#verify` 只检查过期时间，不检查用户状态：用户被禁用后，已签发的 token 在 2 小时内仍可用（`TokenService#verify`、`AuthInterceptor#preHandle`）。
- token 只在单进程内存中，多实例部署时无法共享（`TokenService`）。
- 登录失败的 401 也会触发前端响应拦截器的清 token 与跳转逻辑（`frontend/src/api/request.js`）。
