package com.example.admin.role;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface RoleMapper {
    @Select("SELECT id, name, description FROM roles ORDER BY id")
    List<Role> selectAll();
}
