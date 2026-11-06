package com.example.admin.user;

import com.example.admin.auth.TokenService;
import com.example.admin.common.ApiResponse;
import com.example.admin.common.PageResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping
    public ApiResponse<PageResult<User>> list(
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return ApiResponse.ok(userService.list(keyword, page, size));
    }

    @GetMapping("/{id}")
    public ApiResponse<User> detail(@PathVariable Long id) {
        return ApiResponse.ok(userService.get(id));
    }

    @PostMapping("/{id}/disable")
    public ApiResponse<Void> disable(@PathVariable Long id, @RequestAttribute(TokenService.USER_ID_ATTR) Long operatorId) {
        userService.disable(id, operatorId);
        return ApiResponse.ok(null);
    }
}
