import axios from 'axios';
import router from '../router';

const TOKEN_KEY = 'ua_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

const request = axios.create({ baseURL: '/api', timeout: 10000 });

request.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

request.interceptors.response.use(
  (res) => res.data.data,
  (err) => {
    if (err.response?.status === 401) {
      clearToken();
      router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } });
    }
    return Promise.reject(err.response?.data ?? err);
  },
);

export default request;
