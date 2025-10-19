// src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// 구 프로젝트의 설정을 위한 타입
type SettingsData = {
  interval?: number;
  resolution?: number | string; // 구 프로젝트는 string도 가능했음
  deleteAfterUpload?: boolean;
  // (statusText, isRecording은 UI 상태이므로 여기서 제외)
};

// 통계 데이터 타입
type StatsData = {
  totalShots: number; // screenshot/ 폴더 내 .png 개수
  totalSize: number;  // screenshot/ 폴더 내 .png 총 크기 (bytes)
  uploadedCount: number; // screenshot/uploaded/ 폴더 내 .png 개수 (구: deletedCount)
};

contextBridge.exposeInMainWorld('electronAPI', {
  // --- 기존 함수 ---
  startCapture: (settings: { interval: number; resolution: number }) =>
    ipcRenderer.invoke('start-capture', settings),
  stopCapture: () =>
    ipcRenderer.invoke('stop-capture'),

  // --- 👇 [추가] ---

  // 설정 읽기
  readSettings: (): Promise<SettingsData> => ipcRenderer.invoke('settings:read'),

  // 설정 쓰기
  writeSettings: (settings: SettingsData): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:write', settings),

  // 통계 가져오기
  getStats: (): Promise<StatsData> => ipcRenderer.invoke('stats:get'),

  // 최근 스크린샷 목록 (Data URL 배열) 가져오기
  listScreenshots: (limit?: number): Promise<string[]> => ipcRenderer.invoke('screenshots:list', limit),

  // 창 닫기
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),

  // Main 프로세스로부터 로그 메시지를 받을 리스너 등록
  // 사용법: window.electronAPI.onLogMessage((message) => { console.log(message); });
  onLogMessage: (callback: (message: string) => void) => {
    const listener = (event, message) => callback(message);
    ipcRenderer.on('log-message', listener);
    // 클린업 함수 반환
    return () => ipcRenderer.removeListener('log-message', listener);
  },
});