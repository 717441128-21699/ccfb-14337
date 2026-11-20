import { initEditor } from './app.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('缺少 #app 挂载点');
initEditor(root);
