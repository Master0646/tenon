package com.example.admin.auth;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/** 内存中的 token 存储：服务重启后所有 token 失效 */
@Service
public class TokenService {
    public static final String USER_ID_ATTR = "currentUserId";
    static final Duration TTL = Duration.ofHours(2);

    private record Session(Long userId, Instant expiresAt) {}

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    public String issue(Long userId) {
        String token = UUID.randomUUID().toString();
        sessions.put(token, new Session(userId, Instant.now().plus(TTL)));
        return token;
    }

    /** 返回 token 对应的用户 ID；token 不存在或已过期时返回 null */
    public Long verify(String token) {
        Session s = token == null ? null : sessions.get(token);
        if (s == null || s.expiresAt().isBefore(Instant.now())) {
            return null;
        }
        return s.userId();
    }
}
