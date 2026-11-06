---
schema_version: 1
title: 项目基础设施
verified_commit: 5da090b
sources:
  - path: backend/pom.xml
  - path: backend/src/main/java/com/example/admin/AdminApplication.java
    symbol: AdminApplication
  - path: backend/src/main/resources/application.yml
  - path: backend/src/main/java/com/example/admin/common/ApiResponse.java
    symbol: ApiResponse
  - path: backend/src/main/java/com/example/admin/common/BusinessException.java
    symbol: BusinessException
  - path: backend/src/main/java/com/example/admin/common/GlobalExceptionHandler.java
    symbol: GlobalExceptionHandler
  - path: backend/src/main/java/com/example/admin/common/PageResult.java
    symbol: PageResult
  - path: backend/src/main/java/com/example/admin/auth/AuthInterceptor.java
    symbol: AuthInterceptor#preHandle
  - path: .devflow/project.yaml
  - path: frontend/package.json
  - path: frontend/vite.config.js
  - path: frontend/src/api/request.js
related_specs: []
---

# 项目基础设施

## 职责
前后端技术栈、端口与数据源配置、统一响应格式与异常处理、前端 HTTP 封装。

## 调用链
前端 `frontend/src/api/request.js` 的 axios 实例（`baseURL: '/api'`）→ Vite 开发服务器代理 `/api` 到 `http://localhost:8081`（`frontend/vite.config.js`）→ Spring Boot 后端 Controller → 返回 `ApiResponse`；异常经 `GlobalExceptionHandler` 转成 `ApiResponse`。

## 关键规则
- 统一响应 `ApiResponse(code, message, data)`：成功时 `code = 0`、`message = "ok"`（`ApiResponse#ok`）。
- `BusinessException(code, message)` 被转成 HTTP 状态码与 `code` 相同的响应（`GlobalExceptionHandler#business`）。
- 参数校验异常 `MethodArgumentNotValidException` → 400 "参数校验失败"（`GlobalExceptionHandler#invalid`）。
- 其他异常 → 500 "服务器内部错误"（`GlobalExceptionHandler#other`）。
- 分页结果 `PageResult(items, total)`（`PageResult`）。
- 前端响应拦截器成功时直接返回 `res.data.data`（即 `ApiResponse.data`）；失败时 reject `err.response.data`（即 `ApiResponse`，可读 `message`），无响应时 reject 原错误；401 处理见 [认证与登录](auth.md)（`frontend/src/api/request.js`）。
- 前端请求超时 10000 ms（`frontend/src/api/request.js`）。

## 配置与依赖
- 后端：Spring Boot 3.3.4，Java 17；依赖 `spring-boot-starter-web`、`spring-boot-starter-validation`、`mybatis-spring-boot-starter` 3.0.3、`mysql-connector-j`、`spring-security-crypto`（`backend/pom.xml`）。
- 入口 `AdminApplication`，`@MapperScan("com.example.admin")`（`AdminApplication`）。
- 后端端口 8081（`backend/src/main/resources/application.yml` 的 `server.port`）。
- 数据源：MySQL，配置在 `backend/src/main/resources/application.yml` 的 `spring.datasource`；用户名、密码通过环境变量 `DB_USER`、`DB_PASSWORD` 注入。
- MyBatis：`mapper-locations: classpath:mapper/*.xml`，开启 `map-underscore-to-camel-case`（`backend/src/main/resources/application.yml`）。
- 前端：Vue 3、vue-router 4、Element Plus、axios，Vite 构建；脚本 `dev`、`build`（`frontend/package.json`）。
- 前端开发端口 5173（`frontend/vite.config.js`）。

## 已知限制
- 项目中没有测试代码，`.devflow/project.yaml` 的 `verify` 为空。
- 没有定时任务、外部服务调用。
- `GlobalExceptionHandler#other` 吞掉异常详情，未见日志记录。
- 拦截器返回 401 时不经过 `GlobalExceptionHandler`，响应体为空，不是 `ApiResponse` 格式（`AuthInterceptor`，见 [认证与登录](auth.md)）。
