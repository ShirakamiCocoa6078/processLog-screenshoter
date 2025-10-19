// src/index.ts
import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises'; // Async 파일 시스템 API
import { ChildProcess, spawn } from 'child_process';
import axios from 'axios';

// Squirrel 업데이트 핸들러 (Windows 설치용)
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Webpack이 주입하는 전역 변수
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// --- 전역 변수 및 경로 정의 ---
const isDev = !app.isPackaged;
const resourcesPath = isDev
  ? path.join(__dirname, '../../') // 개발: 프로젝트 루트
  : process.resourcesPath;         // 배포: resources 폴더

// 1. Python 자식 프로세스 참조 변수
let appPy: ChildProcess | null = null;
let uploaderPy: ChildProcess | null = null;
let mainWindowRef: BrowserWindow | null = null; // mainWindow 참조 저장

// 2. Python 스크립트 실행 경로
const pythonPath = isDev ? 'python' : path.join(resourcesPath, 'venv', 'python.exe'); // (배포 시 venv 경로)
const appPyPath = path.join(resourcesPath, 'backend', 'app.py');
const uploaderPyPath = path.join(resourcesPath, 'backend', 'uploader.py');

// 3. UI 로드 URL 및 API
const UI_URL = 'https://process-log.vercel.app';
const LOCAL_FLASK_API = 'http://localhost:5001';

// 4. 파일 및 폴더 이름
const SETTINGS_FILE_NAME = 'user-settings.json';
const SCREENSHOT_FOLDER = 'screenshot';
const UPLOADED_SUBFOLDER = 'uploaded';

// 5. [수정] 동적 경로 정의
// 사용자 데이터 폴더 내 설정 파일 경로 (app.getPath 사용 보장)
const userSettingsPath = path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
// 프로젝트 루트 내 스크린샷 폴더 경로
const screenshotPath = path.join(resourcesPath, SCREENSHOT_FOLDER);
const uploadedPath = path.join(screenshotPath, UPLOADED_SUBFOLDER);
// 프로젝트 루트 내 업로더 설정 파일 경로
const uploaderConfigPath = path.join(resourcesPath, 'uploader_config.json'); // CONFIG_FILE_PATH -> uploaderConfigPath

const defaultSettings = {
  interval: 5,         // 초 단위
  resolution: '1.0',   // 문자열
  deleteAfterUpload: false,
};

// --- 유틸리티 함수 ---

const sendLogToUI = (message: string) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('log-message', `[${new Date().toLocaleTimeString()}] ${message}`);
  }
  console.log(`[LOG] ${message}`); // 메인 프로세스 콘솔에도 출력
};

// [추가] 설정을 읽는 별도 함수
async function readSettings(): Promise<typeof defaultSettings> {
  try {
    if (fs.existsSync(userSettingsPath)) {
      const content = await fsp.readFile(userSettingsPath, 'utf8');
      // 기본값과 병합하여 반환 (누락된 키 방지)
      return { ...defaultSettings, ...JSON.parse(content) };
    }
  } catch (error) {
    sendLogToUI(`[오류] 설정 파일 읽기 실패: ${error.message}`);
  }
  return defaultSettings; // 실패 시 기본값 반환
}

// --- createWindow 함수 ---
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

// --- Python 프로세스 관리 ---

// Python 프로세스 실행
const startPythonProcesses = () => {
  sendLogToUI('Starting Python processes...');
  // console.log('App.py Path:', appPyPath);
  // console.log('Uploader.py Path:', uploaderPyPath);

  try { // [추가] spawn 자체에서 오류가 발생할 수 있으므로 try...catch 추가
    // (1) 캡처 서버 (app.py) 실행
    appPy = spawn(pythonPath, [appPyPath]);

    if (appPy) {
      appPy.stdout.on('data', (data) => sendLogToUI(`[App.py]: ${data.toString().trim()}`));
      appPy.stderr.on('data', (data) => sendLogToUI(`[App.py ERR]: ${data.toString().trim()}`));
      appPy.on('close', (code) => sendLogToUI(`App.py 종료됨 (코드: ${code})`));
      appPy.on('error', (err) => sendLogToUI(`[App.py SPAWN ERR]: ${err.message}`)); // [추가] spawn 오류 처리
    } else {
      sendLogToUI('[오류] App.py 프로세스를 시작하지 못했습니다.');
    }

    // (2) 업로더 (uploader.py) 실행
    uploaderPy = spawn(pythonPath, [uploaderPyPath]);

    if (uploaderPy) {
      uploaderPy.stdout.on('data', (data) => sendLogToUI(`[Uploader.py]: ${data.toString().trim()}`));
      uploaderPy.stderr.on('data', (data) => sendLogToUI(`[Uploader.py ERR]: ${data.toString().trim()}`));
      uploaderPy.on('close', (code) => sendLogToUI(`Uploader.py 종료됨 (코드: ${code})`));
      uploaderPy.on('error', (err) => sendLogToUI(`[Uploader.py SPAWN ERR]: ${err.message}`)); // [추가] spawn 오류 처리
    } else {
      sendLogToUI('[오류] Uploader.py 프로세스를 시작하지 못했습니다.');
    }
  } catch (error) { // [추가] spawn 자체 오류 처리
      sendLogToUI(`[오류] Python 프로세스 spawn 실패: ${error.message}`);
      appPy = null; // 오류 발생 시 null로 확실히 설정
      uploaderPy = null;
  }
};
// Python 프로세스 종료
const killPythonProcesses = () => {
  console.log('Stopping Python processes...');
  if (appPy) appPy.kill();
  if (uploaderPy) uploaderPy.kill();
};

// --- 인증 토큰 관리 ---

const updateUploaderConfig = (token: string | null, email: string | null) => {
  try {
    const config = {
      sessionToken: token,
      userEmail: email,
    };
    // [수정] uploaderConfigPath 사용
    fs.writeFileSync(uploaderConfigPath, JSON.stringify(config, null, 2));
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
    // 우리가 찾는 쿠키 이름
    const AUTH_COOKIE_NAME = '__Secure-next-auth.session-token';
    // (Vercel 배포 시 __Secure- 접두사가 붙습니다. 로컬 테스트 시 'next-auth.session-token')
    const LOCAL_AUTH_COOKIE_NAME = 'next-auth.session-token';
  const filter = { urls: [UI_URL + '/*'] };

  session.defaultSession.cookies.on('changed', async (event, cookie, cause, removed) => {

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
    try { // [추가] 오류 처리를 위해 try...catch 추가
      const cookies = await session.defaultSession.cookies.get({ url: UI_URL });
      // 👇 [수정] 함수 최상단에 정의된 상수 사용
      const authToken = cookies.find(c => c.name === AUTH_COOKIE_NAME || c.name === LOCAL_AUTH_COOKIE_NAME);
      if (authToken) {
        updateUploaderConfig(authToken.value, null);
      } else {
        updateUploaderConfig(null, null); // 초기화
      }
    } catch (error) { // [추가] 쿠키 읽기 오류 처리
        sendLogToUI(`[오류] 초기 쿠키 확인 실패: ${error.message}`);
        updateUploaderConfig(null, null); // 오류 시에도 초기화
    }
  })();
};

// --- Electron App Lifecycle ---

app.on('ready', () => {
  // UserAgent 설정 (Google 로그인용)
  const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  session.defaultSession.setUserAgent(chromeUserAgent);

  setupAuthTokenListener(); //쿠키 리스너 시작
  startPythonProcesses();
  createWindow();
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

// --- IPC 핸들러 (UI -> Main) ---

// 캡처 시작 요청 (UI -> Main -> app.py)
ipcMain.handle('start-capture', async (event, settings) => {
  // 👇 [추가] 핸들러 호출 로그
  sendLogToUI('IPC 핸들러 "start-capture" 수신. 설정: ' + JSON.stringify(settings));
  try {
    // 👇 [추가] Axios 호출 직전 로그
    sendLogToUI(`Axios POST 요청 전송 시도: ${LOCAL_FLASK_API}/start`);

    const response = await axios.post(`${LOCAL_FLASK_API}/start`, settings);

    // 👇 [추가] Axios 응답 성공 로그
    sendLogToUI(`Axios 응답 성공 (${response.status}): ${JSON.stringify(response.data)}`);
    return { success: true, message: response.data.message };

  } catch (error) {
    // 👇 [수정] Axios 오류 상세 로그
    let errorMessage = '알 수 없는 오류';
    if (axios.isAxiosError(error)) { // Axios 오류인지 확인
      errorMessage = error.message;
      if (error.response) {
        // 서버가 오류 응답을 반환한 경우 (4xx, 5xx)
        errorMessage += ` | 서버 응답 (${error.response.status}): ${JSON.stringify(error.response.data)}`;
      } else if (error.request) {
        // 요청은 보냈으나 응답을 받지 못한 경우 (네트워크 오류, 서버 다운 등)
        errorMessage += ' | 서버로부터 응답을 받지 못했습니다. Flask 서버(app.py)가 실행 중인지 확인하세요.';
      }
    } else if (error instanceof Error) {
        errorMessage = error.message;
    }
    sendLogToUI(`[오류] Axios POST 요청 실패: ${errorMessage}`); // 상세 오류 로그 UI 전송
    console.error('[IPC Error] Start Capture:', error); // 콘솔에도 전체 오류 출력
    return { success: false, message: errorMessage }; // UI에도 오류 메시지 전달
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

// [수정] 설정 읽기 핸들러 (별도 함수 호출)
ipcMain.handle('settings:read', async () => {
  return await readSettings();
});

// [수정] 설정 쓰기 핸들러 (별도 함수 호출)
ipcMain.handle('settings:write', async (event, settings) => {
  try {
    const currentSettings = await readSettings(); // 수정된 readSettings 함수 사용
    const newSettings = { ...currentSettings, ...settings }; // 병합
    await fsp.writeFile(userSettingsPath, JSON.stringify(newSettings, null, 2), 'utf8');

    // uploader_config.json에도 deleteAfterUpload 반영
    if (typeof settings.deleteAfterUpload === 'boolean') {
        try {
            let uploaderCfg = {};
             if (fs.existsSync(uploaderConfigPath)) { // [수정] uploaderConfigPath 사용
                 try {
                     uploaderCfg = JSON.parse(await fsp.readFile(uploaderConfigPath, 'utf-8')); // [수정] uploaderConfigPath 사용
                 } catch {/*무시*/}
             }
            const nextUploaderCfg = {...uploaderCfg, deleteAfterUpload: settings.deleteAfterUpload };
            await fsp.writeFile(uploaderConfigPath, JSON.stringify(nextUploaderCfg, null, 2), 'utf8'); // [수정] uploaderConfigPath 사용
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

// [수정] 통계 가져오기 핸들러
ipcMain.handle('stats:get', async () => {
  const stats: { totalShots: number; totalSize: number; uploadedCount: number } = {
    totalShots: 0,
    totalSize: 0,
    uploadedCount: 0,
  };
  try {
    // screenshotPath (전역 변수) 접근 확인
    if (fs.existsSync(screenshotPath)) {
      const files = await fsp.readdir(screenshotPath);
      for (const file of files) {
        // [수정] uploaded 폴더 자체 제외
        if (file.toLowerCase().endsWith('.png') && file !== UPLOADED_SUBFOLDER) { 
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
    } else {
        // [추가] 폴더 없을 시 로그
        sendLogToUI(`[정보] 스크린샷 폴더 없음: ${screenshotPath}`);
    }

    // uploadedPath (전역 변수) 접근 확인
    if (fs.existsSync(uploadedPath)) {
        const uploadedFiles = await fsp.readdir(uploadedPath);
        // [수정] filter로 변경
        stats.uploadedCount = uploadedFiles.filter(f => f.toLowerCase().endsWith('.png')).length;
    } else {
        // [추가] 폴더 없을 시 로그
        sendLogToUI(`[정보] 업로드 폴더 없음: ${uploadedPath}`);
    }
  } catch (error) {
    sendLogToUI(`[오류] 통계 계산 실패: ${error.message}`);
  }
  return stats;
});

// [수정] 스크린샷 목록 핸들러 (Data URL 반환)
ipcMain.handle('screenshots:list', async (event, limit = 4) => {
  const results: string[] = [];
  try {
    // screenshotPath (전역 변수) 접근 확인
    if (fs.existsSync(screenshotPath)) {
      const files = await fsp.readdir(screenshotPath);
      const pngFiles: { path: string; mtime: number }[] = [];
      for (const file of files) {
        // [수정] uploaded 폴더 자체 제외
        if (file.toLowerCase().endsWith('.png') && file !== UPLOADED_SUBFOLDER) {
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
    } else {
        // [추가] 폴더 없을 시 로그
        sendLogToUI(`[정보] 스크린샷 폴더 없음 (목록): ${screenshotPath}`);
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