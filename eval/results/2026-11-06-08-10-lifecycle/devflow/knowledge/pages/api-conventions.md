---
schema_version: 1
title: 接口响应与异常处理
verified_commit: "8710d3b"
sources:
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
  - path: frontend/src/api/request.js
related_specs: []
---

# 接口响应与异常处理

## 职责
统一后端响应格式与错误码，以及前端 axios 对响应的解包和错误处理。

## 调用链
Controller 返回 `ApiResponse.ok(data)`；Service 抛 `BusinessException(code, message)` → `GlobalExceptionHandler#business` → HTTP 状态码 = `code` 的 `ApiResponse.error` → 前端 `frontend/src/api/request.js` 响应拦截器。

## 关键规则
- 响应结构 `{ code, message, data }`：成功 `code = 0`、`message = "ok"`（`ApiResponse#ok`）；失败 `data = null`（`ApiResponse#error`）。
- `BusinessException` 的 `code` 同时作为 HTTP 状态码（`GlobalExceptionHandler#business`）。
- 参数校验失败（`MethodArgumentNotValidException`）→ 400 "参数校验失败"（`GlobalExceptionHandler#invalid`）。
- 其他异常 → 500 "服务器内部错误"（`GlobalExceptionHandler#other`）。
- 分页结构 `{ items, total }`（`PageResult`）。
- 鉴权失败由拦截器直接返回 401，不经过 `GlobalExceptionHandler`，无 JSON 体（`AuthInterceptor#preHandle`）。
- 前端 axios：`baseURL` 为 `/api`，超时 10000 ms；成功时直接返回 `res.data.data`；失败时 reject `err.response.data`（即 `{ code, message }`），无响应时 reject 原始错误（`frontend/src/api/request.js`）。

## 配置与依赖
无独立配置。

## 已知限制
- 前端成功分支不检查 `code` 字段，只依赖 HTTP 状态码区分成败（`frontend/src/api/request.js`）。
