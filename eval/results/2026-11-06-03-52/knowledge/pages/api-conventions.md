---
schema_version: 1
title: 接口约定与运行配置
verified_commit: d1fae38
sources:
  - path: backend/src/main/java/com/example/admin/common/ApiResponse.java
    symbol: ApiResponse
  - path: backend/src/main/java/com/example/admin/common/BusinessException.java
    symbol: BusinessException
  - path: backend/src/main/java/com/example/admin/common/GlobalExceptionHandler.java
    symbol: GlobalExceptionHandler
  - path: backend/src/main/java/com/example/admin/common/PageResult.java
    symbol: PageResult
  - path: backend/src/main/java/com/example/admin/AdminApplication.java
    symbol: AdminApplication
  - path: backend/src/main/resources/application.yml
  - path: backend/pom.xml
  - path: frontend/src/api/request.js
  - path: frontend/vite.config.js
  - path: frontend/package.json
related_specs: []
---

# 接口约定与运行配置

## 职责
后端统一响应格式与异常转换、前端 axios 封装，以及前后端的端口、代理、数据源等运行配置。

## 调用链
前端 API 函数 → `request`（axios 实例，`baseURL: '/api'`，超时 10000ms，`frontend/src/api/request.js:10`）→ Vite 开发代理 `/api` → `http://localhost:8081`（`frontend/vite.config.js:8-10`）→ Spring Boot Controller 返回 `ApiResponse` → 异常由 `GlobalExceptionHandler` 转为 `ApiResponse`。

## 关键规则
- 响应体 `ApiResponse(code, message, data)`：成功时 `code=0`、`message="ok"`（`ApiResponse#ok`，`backend/src/main/java/com/example/admin/common/ApiResponse.java:5-7`）；失败时 `data` 为 null（`ApiResponse#error`，`ApiResponse.java:9-11`）。
- `BusinessException(code, message)`：HTTP 状态码与 `code` 字段相同（`GlobalExceptionHandler#business`，`backend/src/main/java/com/example/admin/common/GlobalExceptionHandler.java:11-14`）。
- 参数校验失败（`MethodArgumentNotValidException`）：400“参数校验失败”（`GlobalExceptionHandler#invalid`，`GlobalExceptionHandler.java:16-19`）。
- 其他异常：500“服务器内部错误”（`GlobalExceptionHandler#other`，`GlobalExceptionHandler.java:21-24`）。
- 分页结果 `PageResult(items, total)`（`backend/src/main/java/com/example/admin/common/PageResult.java:5`）。
- 前端响应拦截器成功时直接返回 `res.data.data`；失败时 reject `err.response.data`（即 `ApiResponse`，可读 `message`），无响应体时 reject 原错误（`request.js:18-27`）。

## 配置与依赖
- 后端：Spring Boot 3.3.4、Java 17、MyBatis Spring Boot Starter 3.0.3、MySQL 驱动、Bean Validation、spring-security-crypto（`backend/pom.xml:4-37`）。
- 后端端口 8081（`backend/src/main/resources/application.yml:2`）。
- 数据源配置在 `application.yml` 的 `spring.datasource`，MySQL 库名 `user_admin`；用户名和密码从环境变量读取（`application.yml:5-8`）。
- MyBatis：`mapper-locations: classpath:mapper/*.xml`，开启下划线转驼峰（`application.yml:10-13`）；`@MapperScan("com.example.admin")`（`backend/src/main/java/com/example/admin/AdminApplication.java:8`）。
- 前端：Vue 3、vue-router 4、Element Plus、axios，Vite 构建，开发端口 5173（`frontend/package.json:9-17`；`frontend/vite.config.js:7`）。
- 建表脚本 `backend/src/main/resources/schema.sql`；`application.yml` 中没有 `spring.sql.init` 配置，是否在启动时自动执行（未核实）。

## 已知限制
- 未配置定时任务、外部服务、CORS；前端依赖 Vite 代理访问后端（`frontend/vite.config.js`；`backend` 下无相关配置）。
- 生产环境下前端如何转发 `/api` 未在仓库中配置（未核实）。
- `GlobalExceptionHandler#other` 吞掉异常信息且未见日志记录（`GlobalExceptionHandler.java:21-24`）。
- 项目中没有测试代码，`.devflow/project.yaml` 的 `verify` 为空（`.devflow/project.yaml`）。
