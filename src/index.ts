// src/index.ts
import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { ChildProcess, spawn } from 'child_process';
import axios from 'axios';

// Squirrel 업데이트 핸들러 (Windows 설치용)
if (require('electron-squirrel-startup')) {
  app.quit();
}
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

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
const SETTINGS_FILE_NAME = 'user-settings.json';
const SCREENSHOT_FOLDER = 'screenshot';
const UPLOADED_SUBFOLDER = 'uploaded';

// 3. UI 로드 URL (1단계에서 만든 Vercel 서버)
const UI_URL = 'https://process-log.vercel.app';
const LOCAL_FLASK_API = 'http://localhost:5001';
const CONFIG_FILE_PATH = path.join(resourcesPath, 'uploader_config.json');

const defaultSettings = {
  interval: 5,         // 초 단위
  resolution: '1.0',   // 문자열
  deleteAfterUpload: false,
};

let mainWindowRef: BrowserWindow | null = null; // mainWindow 참조 저장
const sendLogToUI = (message: string) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('log-message', `[${new Date().toLocaleTimeString()}] ${message}`);
  }
  console.log(`[LOG] ${message}`); // 메인 프로세스 콘솔에도 출력
};

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    height: 950,
    width: 1300,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });
  mainWindowRef = mainWindow;
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
const updateUploaderConfig = (token: string | null, email: string | null) => {
  try {
    const config = {
      sessionToken: token,
      userEmail: email,
    };
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
    if(token) {
      console.log('[Auth] uploader_config.json에 세션 토큰 저장 성공.');
    } else {
      console.log('[Auth] 로그아웃. uploader_config.json 초기화.');
    }
  } catch (error) {
    console.error('[Auth] uploader_config.json 쓰기 실패:', error);
  }
};
const setupAuthTokenListener = () => {
  // Vercel 도메인에 대한 쿠키만 감시
  const filter = { urls: [UI_URL + '/*'] };

  session.defaultSession.cookies.on('changed', async (event, cookie, cause, removed) => {
    
    // 우리가 찾는 쿠키 이름
    const AUTH_COOKIE_NAME = '__Secure-next-auth.session-token'; 
    // (Vercel 배포 시 __Secure- 접두사가 붙습니다. 로컬 테스트 시 'next-auth.session-token')

    if (cookie.name === AUTH_COOKIE_NAME || cookie.name === 'next-auth.session-token') {
      if (removed || cause === 'expired') {
        // 로그아웃 또는 만료
        updateUploaderConfig(null, null);
      } else if (cause === 'explicit') {
        // 로그인 성공 (쿠키 생성됨)
        // (이메일은 현재 알 수 없으므로 null 또는 다른 IPC로 받아와야 함)
        // (우선 토큰만 저장)
        updateUploaderConfig(cookie.value, null);
      }
    }
  });
  (async () => {
    const cookies = await session.defaultSession.cookies.get({ url: UI_URL });
    const authToken = cookies.find(c => c.name === AUTH_COOKIE_NAME || c.name === 'next-auth.session-token');
    if (authToken) {
      updateUploaderConfig(authToken.value, null);
    } else {
      updateUploaderConfig(null, null); // 초기화
    }
  })();
};
// --- Electron App Lifecycle ---

app.on('ready', () => {
  const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  session.defaultSession.setUserAgent(chromeUserAgent);

  setupAuthTokenListener();
  startPythonProcesses();
  createWindow();
});
app.on('window-all-closed', () => { //쿠키 리스너 시작
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
// 설정 읽기 핸들러
ipcMain.handle('settings:read', async () => {
  try {
    if (fs.existsSync(userSettingsPath)) {
      const content = await fsp.readFile(userSettingsPath, 'utf8');
      return { ...defaultSettings, ...JSON.parse(content) };
    }
  } catch (error) {
    sendLogToUI(`[오류] 설정 파일 읽기 실패: ${error.message}`);
  }
  return defaultSettings; // 실패 시 기본값 반환
});

// 설정 쓰기 핸들러
ipcMain.handle('settings:write', async (event, settings) => {
  try {
    const currentSettings = await ipcMain.invoke('settings:read'); // 현재 설정 읽기
    const newSettings = { ...currentSettings, ...settings }; // 병합
    await fsp.writeFile(userSettingsPath, JSON.stringify(newSettings, null, 2), 'utf8');

    // uploader_config.json에도 deleteAfterUpload 반영 (구 프로젝트 로직)
    if (typeof settings.deleteAfterUpload === 'boolean') {
        try {
            let uploaderCfg = {};
             if (fs.existsSync(uploaderConfigPath)) {
                 try {
                     uploaderCfg = JSON.parse(await fsp.readFile(uploaderConfigPath, 'utf-8'));
                 } catch {/*무시*/}
             }
            const nextUploaderCfg = {...uploaderCfg, deleteAfterUpload: settings.deleteAfterUpload };
            await fsp.writeFile(uploaderConfigPath, JSON.stringify(nextUploaderCfg, null, 2), 'utf8');
        } catch (e) {
             sendLogToUI(`[오류] uploader_config.json 업데이트 실패: ${e.message}`);
        }
    }

    sendLogToUI('설정 저장됨.');
    return { success: true };
  } catch (error) {
    sendLogToUI(`[오류] 설정 파일 쓰기 실패: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// 통계 가져오기 핸들러
ipcMain.handle('stats:get', async () => {
  const stats: { totalShots: number; totalSize: number; uploadedCount: number } = {
    totalShots: 0,
    totalSize: 0,
    uploadedCount: 0,
  };
  try {
    // screenshot 폴더 스캔
    if (fs.existsSync(screenshotPath)) {
      const files = await fsp.readdir(screenshotPath);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.png')) {
          const filePath = path.join(screenshotPath, file);
          try {
            const fileStat = await fsp.stat(filePath);
            if (fileStat.isFile()) {
              stats.totalShots++;
              stats.totalSize += fileStat.size;
            }
          } catch { /* 파일 접근 오류 무시 */ }
        }
      }
    }
    // uploaded 폴더 스캔
    if (fs.existsSync(uploadedPath)) {
        const uploadedFiles = await fsp.readdir(uploadedPath);
        for (const file of uploadedFiles) {
             if (file.toLowerCase().endsWith('.png')) {
                 stats.uploadedCount++;
             }
        }
    }
  } catch (error) {
    sendLogToUI(`[오류] 통계 계산 실패: ${error.message}`);
  }
  return stats;
});

// 스크린샷 목록 핸들러 (Data URL 반환)
ipcMain.handle('screenshots:list', async (event, limit = 4) => {
  const results: string[] = [];
  try {
    if (fs.existsSync(screenshotPath)) {
      const files = await fsp.readdir(screenshotPath);
      const pngFiles: { path: string; mtime: number }[] = [];
      for (const file of files) {
        if (file.toLowerCase().endsWith('.png')) {
          const filePath = path.join(screenshotPath, file);
          try {
            const stat = await fsp.stat(filePath);
            if (stat.isFile()) {
              pngFiles.push({ path: filePath, mtime: stat.mtimeMs });
            }
          } catch { /* 무시 */ }
        }
      }
      // 최신순 정렬
      pngFiles.sort((a, b) => b.mtime - a.mtime);
      // 제한 개수만큼 읽어서 Data URL 생성
      const latestFiles = pngFiles.slice(0, limit);
      for (const fileInfo of latestFiles) {
        try {
          const buffer = await fsp.readFile(fileInfo.path);
          const base64 = buffer.toString('base64');
          results.push(`data:image/png;base64,${base64}`);
        } catch { /* 파일 읽기 오류 무시 */ }
      }
    }
  } catch (error) {
    sendLogToUI(`[오류] 스크린샷 목록 생성 실패: ${error.message}`);
  }
  return results;
});

// 창 닫기 핸들러
ipcMain.handle('window:close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    window.close();
  }
});