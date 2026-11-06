package com.example.admin.user;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface UserMapper {
    List<User> selectPage(@Param("keyword") String keyword, @Param("offset") int offset, @Param("limit") int limit);

    long count(@Param("keyword") String keyword);

    User selectById(@Param("id") Long id);

    User selectByUsername(@Param("username") String username);

    int updateStatus(@Param("id") Long id, @Param("status") User.Status status);
}
