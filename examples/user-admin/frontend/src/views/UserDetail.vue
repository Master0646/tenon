<template>
  <el-descriptions v-if="user" :title="user.username" :column="1" border>
    <el-descriptions-item label="邮箱">{{ user.email }}</el-descriptions-item>
    <el-descriptions-item label="角色">{{ user.roleName }}</el-descriptions-item>
    <el-descriptions-item label="状态">{{ user.status }}</el-descriptions-item>
    <el-descriptions-item label="创建时间">{{ user.createdAt }}</el-descriptions-item>
  </el-descriptions>
  <router-link to="/users">返回列表</router-link>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { fetchUser } from '../api/user';

const props = defineProps({ id: { type: String, required: true } });
const user = ref(null);

onMounted(async () => {
  user.value = await fetchUser(props.id);
});
</script>
