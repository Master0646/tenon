package com.example.admin.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/** 校验请求头 Authorization: Bearer <token>，通过后把用户 ID 放进请求属性 */
@Component
public class AuthInterceptor implements HandlerInterceptor {
    private final TokenService tokenService;

    public AuthInterceptor(TokenService tokenService) {
        this.tokenService = tokenService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String header = request.getHeader("Authorization");
        String token = header != null && header.startsWith("Bearer ") ? header.substring(7) : null;
        Long userId = tokenService.verify(token);
        if (userId == null) {
            response.setStatus(401);
            return false;
        }
        request.setAttribute(TokenService.USER_ID_ATTR, userId);
        return true;
    }
}
