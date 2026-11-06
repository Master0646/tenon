---
schema_version: 1
title: 项目总览与配置
verified_commit: "45c12ed"
sources:
  - path: backend/pom.xml
  - path: backend/src/main/java/com/example/admin/AdminApplication.java
    symbol: AdminApplication
  - path: backend/src/main/resources/application.yml
  - path: backend/src/main/resources/schema.sql
  - path: backend/src/main/java/com/example/admin/role/Role.java
    symbol: Role
  - path: backend/src/main/java/com/example/admin/role/RoleMapper.java
    symbol: RoleMapper#selectAll
  - path: frontend/package.json
  - path: frontend/vite.config.js
  - path: frontend/src/router/index.js
  - path: backend/src/test/java/com/example/admin/user/UserServiceTest.java
  - path: backend/src/test/java/com/example/admin/auth/AuthServiceTest.java
related_specs: []
---

# 项目总览与配置

## 职责
用户后台管理系统：后端 Spring Boot + MyBatis 提供 `/api` 接口，前端 Vue 3 + Element Plus 提供登录、用户列表、用户详情页面。业务模块见 [登录与鉴权](auth.md)、[用户管理](user-management.md)，接口约定见 [接口响应与异常处理](api-conventions.md)。

## 调用链
浏览器 → Vite 开发服务器（`/api` 代理到后端，`frontend/vite.config.js`）→ Spring MVC 拦截器 `AuthInterceptor` → Controller → Service → MyBatis Mapper → MySQL 表 `users` / `roles`。

## 关键规则
- 技术栈：Spring Boot 3.3.4、Java 17、mybatis-spring-boot-starter 3.0.3、mysql-connector-j、spring-security-crypto（仅用于 BCrypt）；测试依赖 spring-boot-starter-test（test scope）（`backend/pom.xml`）。
- 前端依赖：vue ^3.5.12、vue-router ^4.4.5、element-plus ^2.8.4、axios ^1.7.7，构建工具 vite ^5.4.9（`frontend/package.json`）。
- Mapper 扫描包为 `com.example.admin`（`AdminApplication`，`@MapperScan`）；XML 位置 `classpath:mapper/*.xml`，开启下划线转驼峰（`backend/src/main/resources/application.yml` 的 `mybatis`）。
- 前端路由（`frontend/src/router/index.js`）：`/login`（公开）、`/` 重定向 `/users`、`/users`（UserList.vue）、`/users/:id`（UserDetail.vue，id 作为 props）。
- 数据表（`backend/src/main/resources/schema.sql`）：
  - `roles`：`id`、`name`（VARCHAR(32) 唯一，取值 `ADMIN` 或 `USER`）、`description`；初始化插入 `ADMIN`（管理员）、`USER`（普通用户）。
  - `users`：`id`、`username`（VARCHAR(64) 唯一）、`email`、`password_hash`（BCrypt）、`status`（默认 `ACTIVE`，取值 `ACTIVE`/`DISABLED`）、`role_id`（外键 `fk_users_role` → `roles.id`）、`created_at`（默认当前时间）。
- 角色实体 `Role` 的 `name` 为角色编码 ADMIN 或 USER（`Role`）。

## 配置与依赖
- 后端端口 8081（`application.yml` 的 `server.port`）。
- 数据源配置在 `application.yml` 的 `spring.datasource`，MySQL 库 `user_admin`；用户名、密码来自环境变量 `DB_USER`、`DB_PASSWORD`。
- 前端开发端口 5173，`/api` 代理到 `http://localhost:8081`（`frontend/vite.config.js`）。
- 未发现定时任务或外部服务调用。

## 已知限制
- `RoleMapper#selectAll` 已定义，但仓库中没有任何代码调用它，也没有角色相关的接口（`backend/src/main/java/com/example/admin/role/RoleMapper.java`）。
- 后端测试只有 `UserServiceTest`、`AuthServiceTest` 两个 JUnit 5 + Mockito 单元测试，mock `UserMapper`，不连数据库（`backend/src/test/java/com/example/admin/`）；前端没有测试框架。
