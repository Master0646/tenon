---
schema_version: 1
title: 认证与会话
verified_commit: d1fae38
sources:
  - path: frontend/src/views/Login.vue
  - path: frontend/src/api/user.js
  - path: frontend/src/api/request.js
  - path: frontend/src/router/index.js
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
  - path: backend/src/main/resources/mapper/UserMapper.xml
related_specs: []
---

# 认证与会话

## 职责
用户名 + 密码登录，签发内存中的 Bearer token；后端拦截 `/api/**` 校验 token，前端路由守卫和 axios 拦截器负责携带 token 与跳转登录页。

## 调用链

**登录**
`/login` 路由（`frontend/src/router/index.js:5`，`meta.public`）→ `Login.vue#onSubmit`（`frontend/src/views/Login.vue:21`）→ `login`（`frontend/src/api/user.js:6`，`POST /api/auth/login`）→ `LoginController#login`（`backend/src/main/java/com/example/admin/auth/LoginController.java:24`）→ `AuthService#login`（`backend/src/main/java/com/example/admin/auth/AuthService.java:21`）→ `UserMapper#selectByUsername`（`backend/src/main/resources/mapper/UserMapper.xml:37`）→ `TokenService#issue`（`backend/src/main/java/com/example/admin/auth/TokenService.java:20`）。前端收到 `{ token }` 后 `setToken` 并跳转 `redirect` 参数或 `/users`（`Login.vue:24-26`）。

**请求鉴权**
`request.js` 请求拦截器加 `Authorization: Bearer <token>`（`frontend/src/api/request.js:12-16`）→ `AuthInterceptor#preHandle`（`backend/src/main/java/com/example/admin/auth/AuthInterceptor.java:18`）→ `TokenService#verify`（`TokenService.java:27`）→ 用户 ID 写入请求属性 `currentUserId`（`TokenService.USER_ID_ATTR`，`TokenService.java:13`；`AuthInterceptor.java:26`）。

## 关键规则
- 登录请求体 `username`、`password` 均为 `@NotBlank`（`LoginController.LoginRequest`，`LoginController.java:15`）；校验失败返回 400“参数校验失败”（`backend/src/main/java/com/example/admin/common/GlobalExceptionHandler.java:16-19`）。
- 用户不存在或 BCrypt 校验不通过：401“用户名或密码错误”（`AuthService.java:23-25`）。
- 用户状态为 `DISABLED`：403“用户已被禁用”（`AuthService.java:26-28`）。密码校验先于状态校验。
- token 为随机 UUID，有效期 `TTL` = 2 小时（`TokenService.java:14,21-22`）。
- token 不存在或已过期时 `verify` 返回 null，拦截器返回 HTTP 401（`TokenService.java:28-31`；`AuthInterceptor.java:22-25`）。
- 拦截范围：`/api/**`，排除 `/api/auth/login`（`backend/src/main/java/com/example/admin/auth/WebConfig.java:17-19`）。
- 前端 token 存在 `localStorage` 键 `ua_token`（`request.js:4-8`）。
- 前端路由守卫：非 `meta.public` 页面且无 token 时跳转 `/login?redirect=...`（`frontend/src/router/index.js:14-18`）。
- 任一接口返回 401 时，前端清除 token 并跳转登录页（`request.js:21-24`）。

## 配置与依赖
- 密码哈希使用 `spring-security-crypto` 的 `BCryptPasswordEncoder`（`AuthService.java:13`；`backend/pom.xml:34-37`）。
- 会话存储为进程内 `ConcurrentHashMap`（`TokenService.java:18`）。

## 已知限制
- token 只存在内存中，服务重启后全部失效；多实例部署时不共享（`TokenService` 类注释，`TokenService.java:10`）。
- 过期 token 不会从 `sessions` 中移除，只在校验时判断过期（`TokenService.java:27-33`）。
- 没有登出或撤销 token 的接口；禁用用户后其已有 token 在过期前仍可用（`TokenService`、`AuthInterceptor#preHandle` 均不查用户状态）。
- 拦截器返回 401 时不写响应体，不是 `ApiResponse` 格式（`AuthInterceptor.java:23-24`）。
- 登录接口本身返回 401（密码错误）也会触发前端的 401 处理，跳转到 `/login` 并带上 `redirect`（`request.js:21-24`）。
