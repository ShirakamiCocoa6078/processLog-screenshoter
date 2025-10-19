// src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// UI(Window)에서 접근할 수 있는 'electronAPI' 객체를 노출
contextBridge.exposeInMainWorld('electronAPI', {
  // Main 프로세스의 'start-capture' 핸들러 호출
  startCapture: (settings: { interval: number; resolution: number }) => 
    ipcRenderer.invoke('start-capture', settings),

  // Main 프로세스의 'stop-capture' 핸들러 호출
  stopCapture: () => 
    ipcRenderer.invoke('stop-capture'),

  // (4단계 연동) UI가 토큰을 Main 프로세스로 전송
  setAuthToken: (token: string, email: string) => 
    ipcRenderer.send('set-auth-token', token, email),
});