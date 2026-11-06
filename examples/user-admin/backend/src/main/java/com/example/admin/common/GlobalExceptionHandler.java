package com.example.admin.common;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** 把异常转成 ApiResponse：HTTP 状态码与 code 字段一致 */
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ApiResponse<Void>> business(BusinessException e) {
        return ResponseEntity.status(e.getCode()).body(ApiResponse.error(e.getCode(), e.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> invalid(MethodArgumentNotValidException e) {
        return ResponseEntity.badRequest().body(ApiResponse.error(400, "参数校验失败"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> other(Exception e) {
        return ResponseEntity.internalServerError().body(ApiResponse.error(500, "服务器内部错误"));
    }
}
