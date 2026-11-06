package com.example.admin.auth;

import com.example.admin.common.BusinessException;
import com.example.admin.user.User;
import com.example.admin.user.UserMapper;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class AuthService {
    private final UserMapper userMapper;
    private final TokenService tokenService;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthService(UserMapper userMapper, TokenService tokenService) {
        this.userMapper = userMapper;
        this.tokenService = tokenService;
    }

    /** 校验用户名与密码（BCrypt），成功后签发 token；被禁用的用户不能登录 */
    public String login(String username, String password) {
        User user = userMapper.selectByUsername(username);
        if (user == null || !encoder.matches(password, user.getPasswordHash())) {
            throw new BusinessException(401, "用户名或密码错误");
        }
        if (user.getStatus() == User.Status.DISABLED) {
            throw new BusinessException(403, "用户已被禁用");
        }
        return tokenService.issue(user.getId());
    }
}
