package com.example.admin.auth;

import com.example.admin.common.ApiResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class LoginController {
    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}

    private final AuthService authService;

    public LoginController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/login")
    public ApiResponse<Map<String, String>> login(@Valid @RequestBody LoginRequest req) {
        return ApiResponse.ok(Map.of("token", authService.login(req.username(), req.password())));
    }
}
