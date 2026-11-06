import request from './request';

export const fetchUsers = (params) => request.get('/users', { params });
export const fetchUser = (id) => request.get(`/users/${id}`);
export const disableUser = (id) => request.post(`/users/${id}/disable`);
export const login = (username, password) => request.post('/auth/login', { username, password });
