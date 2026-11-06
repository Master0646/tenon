import { createRouter, createWebHistory } from 'vue-router';
import { getToken } from '../api/request';

const routes = [
  { path: '/login', component: () => import('../views/Login.vue'), meta: { public: true } },
  { path: '/', redirect: '/users' },
  { path: '/users', component: () => import('../views/UserList.vue') },
  { path: '/users/:id', component: () => import('../views/UserDetail.vue'), props: true },
];

const router = createRouter({ history: createWebHistory(), routes });

// 未登录访问非公开页面时跳转登录页
router.beforeEach((to) => {
  if (!to.meta.public && !getToken()) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
});

export default router;
