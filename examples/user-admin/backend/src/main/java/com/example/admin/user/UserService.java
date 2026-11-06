package com.example.admin.user;

import com.example.admin.common.BusinessException;
import com.example.admin.common.PageResult;
import org.springframework.stereotype.Service;

@Service
public class UserService {
    /** 单页最多返回的条数，超过时按此值截断 */
    static final int MAX_PAGE_SIZE = 100;

    private final UserMapper userMapper;

    public UserService(UserMapper userMapper) {
        this.userMapper = userMapper;
    }

    public PageResult<User> list(String keyword, int page, int size) {
        int limit = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        int offset = (Math.max(page, 1) - 1) * limit;
        return new PageResult<>(userMapper.selectPage(keyword, offset, limit), userMapper.count(keyword));
    }

    public User get(Long id) {
        User user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException(404, "用户不存在");
        }
        return user;
    }

    /** 禁用用户：不能禁用自己，也不能禁用 ADMIN 角色的用户 */
    public void disable(Long id, Long operatorId) {
        if (id.equals(operatorId)) {
            throw new BusinessException(400, "不能禁用当前登录的用户");
        }
        User user = get(id);
        if ("ADMIN".equals(user.getRoleName())) {
            throw new BusinessException(403, "不能禁用管理员");
        }
        userMapper.updateStatus(id, User.Status.DISABLED);
    }
}
