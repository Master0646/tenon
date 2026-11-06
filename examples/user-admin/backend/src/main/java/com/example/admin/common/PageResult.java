package com.example.admin.common;

import java.util.List;

public record PageResult<T>(List<T> items, long total) {}
