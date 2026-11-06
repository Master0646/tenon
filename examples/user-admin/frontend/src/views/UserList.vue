<template>
  <div class="user-list">
    <el-input v-model="keyword" placeholder="用户名或邮箱" clearable @change="load(1)" />
    <el-table :data="users" v-loading="loading">
      <el-table-column prop="username" label="用户名" />
      <el-table-column prop="email" label="邮箱" />
      <el-table-column prop="roleName" label="角色" />
      <el-table-column prop="status" label="状态" />
      <el-table-column label="操作">
        <template #default="{ row }">
          <router-link :to="`/users/${row.id}`">详情</router-link>
          <el-button
            v-if="row.status === 'ACTIVE' && row.roleName !== 'ADMIN'"
            type="danger" link @click="onDisable(row)"
          >禁用</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      layout="prev, pager, next, total"
      :total="total" :page-size="pageSize" :current-page="page"
      @current-change="load"
    />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { disableUser, fetchUsers } from '../api/user';

const pageSize = 20;
const users = ref([]);
const total = ref(0);
const page = ref(1);
const keyword = ref('');
const loading = ref(false);

async function load(p = page.value) {
  loading.value = true;
  try {
    const res = await fetchUsers({ keyword: keyword.value, page: p, size: pageSize });
    users.value = res.items;
    total.value = res.total;
    page.value = p;
  } finally {
    loading.value = false;
  }
}

async function onDisable(row) {
  await ElMessageBox.confirm(`确认禁用 ${row.username}？`);
  try {
    await disableUser(row.id);
    ElMessage.success('已禁用');
    load();
  } catch (e) {
    ElMessage.error(e.message ?? '操作失败');
  }
}

onMounted(() => load(1));
</script>
