// src/index.ts
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { ChildProcess, spawn } from 'child_process';
import axios from 'axios';

// Squirrel 업데이트 핸들러 (Windows 설치용)
if (require('electron-squirrel-startup')) {
  app.quit();
}

// 1. Python 자식 프로세스 참조 변수
let appPy: ChildProcess | null = null;
let uploaderPy: ChildProcess | null = null;

// 2. Python 스크립트 실행 경로
// __dirname은 .webpack/main/index.js의 위치가 됩니다.
// process.resourcesPath는 배포 시 'resources' 폴더를 가리킵니다.
const isDev = !app.isPackaged;
const resourcesPath = isDev 
  ? path.join(__dirname, '../../') // 개발: 프로젝트 루트
  : process.resourcesPath;         // 배포: resources 폴더

const pythonPath = isDev ? 'python' : path.join(resourcesPath, 'venv', 'python.exe'); // (배포 시 venv 경로)
const appPyPath = path.join(resourcesPath, 'backend', 'app.py');
const uploaderPyPath = path.join(resourcesPath, 'backend', 'uploader.py');

// 3. UI 로드 URL (1단계에서 만든 Vercel 서버)
const UI_URL = 'https://process-log.vercel.app'; // 👈 1단계에서 배포한 URL
const LOCAL_FLASK_API = 'http://localhost:5001'; // 👈 2단계에서 만든 app.py 주소

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    height: 800,
    width: 1200,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // 👈 3.6에서 만들 파일
    },
  });

  // Vercel 앱 로드
  mainWindow.loadURL(UI_URL);

  // (선택) 개발자 도구 열기
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
};

// 4. Python 프로세스 실행
const startPythonProcesses = () => {
  console.log('Starting Python processes...');
  console.log('App.py Path:', appPyPath);
  console.log('Uploader.py Path:', uploaderPyPath);
  
  // (1) 캡처 서버 (app.py) 실행
  appPy = spawn(pythonPath, [appPyPath]);
  appPy.stdout.on('data', (data) => console.log(`[App.py]: ${data}`));
  appPy.stderr.on('data', (data) => console.error(`[App.py ERR]: ${data}`));

  // (2) 업로더 (uploader.py) 실행
  uploaderPy = spawn(pythonPath, [uploaderPyPath]);
  uploaderPy.stdout.on('data', (data) => console.log(`[Uploader.py]: ${data}`));
  uploaderPy.stderr.on('data', (data) => console.error(`[Uploader.py ERR]: ${data}`));
};

// 5. Python 프로세스 종료
const killPythonProcesses = () => {
  console.log('Stopping Python processes...');
  if (appPy) appPy.kill();
  if (uploaderPy) uploaderPy.kill();
};

// --- Electron App Lifecycle ---

app.on('ready', () => {
  startPythonProcesses(); // Python 먼저 실행
  createWindow();         // 그 다음 창 생성
});

app.on('window-all-closed', () => {
  killPythonProcesses(); // 모든 창이 닫히면 Python 종료
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// --- 6. IPC 핸들러 (UI -> Main) ---

// 캡처 시작 요청 (UI -> Main -> app.py)
ipcMain.handle('start-capture', async (event, settings) => {
  try {
    const response = await axios.post(`${LOCAL_FLASK_API}/start`, settings);
    return { success: true, message: response.data.message };
  } catch (error) {
    console.error('[IPC Error] Start Capture:', error.message);
    return { success: false, message: error.response?.data?.message || error.message };
  }
});

// 캡처 중지 요청 (UI -> Main -> app.py)
ipcMain.handle('stop-capture', async () => {
  try {
    const response = await axios.post(`${LOCAL_FLASK_API}/stop`);
    return { success: true, message: response.data.message };
  } catch (error) {
    console.error('[IPC Error] Stop Capture:', error.message);
    return { success: false, message: error.response?.data?.message || error.message };
  }
});

// (4단계 연동) 인증 토큰을 Main 프로세스에 전달
ipcMain.on('set-auth-token', (event, token, email) => {
  console.log('Auth Token 수신. uploader_config.json 업데이트...');
  // TODO: 4단계에서 이 토큰을 uploader_config.json 파일에 저장하는 로직 구현
});