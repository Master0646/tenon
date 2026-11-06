<template>
  <el-form :model="form" @submit.prevent="onSubmit">
    <el-form-item label="用户名"><el-input v-model="form.username" /></el-form-item>
    <el-form-item label="密码"><el-input v-model="form.password" type="password" /></el-form-item>
    <el-button type="primary" native-type="submit" :loading="loading">登录</el-button>
  </el-form>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { login } from '../api/user';
import { setToken } from '../api/request';

const form = reactive({ username: '', password: '' });
const loading = ref(false);
const route = useRoute();
const router = useRouter();

async function onSubmit() {
  loading.value = true;
  try {
    const { token } = await login(form.username, form.password);
    setToken(token);
    router.push(route.query.redirect || '/users');
  } catch (e) {
    ElMessage.error(e.message ?? '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>
