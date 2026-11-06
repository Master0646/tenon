---
schema_version: 1
title: 认证与登录
verified_commit: 5da090b
sources:
  - path: backend/src/main/java/com/example/admin/auth/LoginController.java
    symbol: LoginController#login
  - path: backend/src/main/java/com/example/admin/auth/AuthService.java
    symbol: AuthService#login
  - path: backend/src/main/java/com/example/admin/auth/TokenService.java
    symbol: TokenService
  - path: backend/src/main/java/com/example/admin/auth/AuthInterceptor.java
    symbol: AuthInterceptor#preHandle
  - path: backend/src/main/java/com/example/admin/auth/WebConfig.java
    symbol: WebConfig#addInterceptors
  - path: backend/src/main/java/com/example/admin/common/GlobalExceptionHandler.java
    symbol: GlobalExceptionHandler#invalid
  - path: backend/src/main/java/com/example/admin/user/UserController.java
    symbol: UserController#disable
  - path: backend/src/main/java/com/example/admin/user/UserMapper.java
    symbol: UserMapper#selectByUsername
  - path: backend/src/main/resources/mapper/UserMapper.xml
  - path: backend/src/main/resources/schema.sql
  - path: frontend/src/views/Login.vue
  - path: frontend/src/api/user.js
  - path: frontend/src/api/request.js
  - path: frontend/src/router/index.js
related_specs: []
---

# 认证与登录

## 职责
用户名 + 密码登录，签发内存 token；后端拦截器校验 `/api/**` 请求的 Bearer token，前端路由守卫与响应拦截器处理未登录跳转。

## 调用链
- 登录：`frontend/src/views/Login.vue`（`onSubmit`）→ `frontend/src/api/user.js#login`（`POST /auth/login`，经 `request` 的 `baseURL: '/api'`）→ `LoginController#login`（`POST /api/auth/login`）→ `AuthService#login` → `UserMapper#selectByUsername`（`backend/src/main/resources/mapper/UserMapper.xml` 中 `selectByUsername`，`users` 左连 `roles`）→ `TokenService#issue`。
- 鉴权：`WebConfig#addInterceptors` 注册 `AuthInterceptor`，拦截 `/api/**`，排除 `/api/auth/login` → `AuthInterceptor#preHandle` 解析 `Authorization: Bearer <token>` → `TokenService#verify` → 把用户 ID 放入请求属性 `TokenService.USER_ID_ATTR`（值 `"currentUserId"`），供 `UserController#disable` 用 `@RequestAttribute` 读取。

## 关键规则
- 请求体 `LoginRequest` 的 `username`、`password` 均 `@NotBlank`，校验失败返回 400 "参数校验失败"（`LoginController#LoginRequest`，`GlobalExceptionHandler#invalid`）。
- 用户不存在或 BCrypt 密码不匹配：401 "用户名或密码错误"（`AuthService#login`）。
- 用户状态为 `DISABLED`：403 "用户已被禁用"；该检查在密码校验之后（`AuthService#login`）。
- 密码存储为 BCrypt 哈希，列 `users.password_hash`（`backend/src/main/resources/schema.sql`）；校验用 `BCryptPasswordEncoder`（`AuthService`）。
- token 为 `UUID.randomUUID()` 字符串，有效期 `TTL = Duration.ofHours(2)`，存于 `ConcurrentHashMap`（`TokenService#issue`、`TokenService#TTL`）。
- token 缺失、不存在或过期时 `verify` 返回 null，拦截器返回 HTTP 401 且不写响应体（`TokenService#verify`、`AuthInterceptor#preHandle`）。
- 登录成功响应 `data` 为 `{ "token": ... }`（`LoginController#login`）。
- 前端 token 存于 `localStorage` 键 `ua_token`，请求时加 `Authorization: Bearer <token>` 头（`frontend/src/api/request.js`）。
- 前端收到 401 时清除 token 并跳转 `/login?redirect=<当前路径>`（`frontend/src/api/request.js`）。
- 路由守卫：非 `meta.public` 的路由在无 token 时跳转 `/login?redirect=...`；只有 `/login` 是 public（`frontend/src/router/index.js`）。
- 登录成功后跳转 `route.query.redirect`，缺省为 `/users`（`frontend/src/views/Login.vue`）。

## 配置与依赖
- BCrypt 来自 `spring-security-crypto` 依赖；未引入完整 Spring Security（见 [项目基础设施](infrastructure.md)）。

## 已知限制
- token 只存在内存中，服务重启后全部失效（`TokenService` 类注释）；多实例部署时 token 不共享（未核实）。
- 没有登出接口，也没有清理过期 token 的逻辑，过期条目留在 Map 中（`TokenService`）。
- 用户被禁用后，已签发的 token 在过期前仍可通过 `AuthInterceptor#preHandle`（拦截器只校验 token，不查用户状态）。
- 没有角色级权限校验：任何已登录用户都能调用 `/api/users/**` 的全部接口（`WebConfig#addInterceptors`、`AuthInterceptor#preHandle`）。
