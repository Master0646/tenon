CREATE TABLE roles (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(32)  NOT NULL UNIQUE COMMENT 'ADMIN 或 USER',
  description VARCHAR(255)
);

CREATE TABLE users (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  email         VARCHAR(128) NOT NULL,
  password_hash VARCHAR(100) NOT NULL COMMENT 'BCrypt',
  status        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE 或 DISABLED',
  role_id       BIGINT       NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id)
);

INSERT INTO roles (name, description) VALUES ('ADMIN', '管理员'), ('USER', '普通用户');
