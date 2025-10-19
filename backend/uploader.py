# backend/uploader.py

import os
import time
import schedule
import requests
import json
import shutil
from image_util import encode_image_to_base64_data_uri # 4번 파일 임포트

# --- 설정 ---
# 스크립트 위치 기준 경로 설정
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENSHOT_DIR = os.path.join(BASE_DIR, 'screenshot')
UPLOADED_DIR = os.path.join(SCREENSHOT_DIR, 'uploaded')
CONFIG_FILE = os.path.join(BASE_DIR, 'uploader_config.json')

# ★ 4단계에서 완성될 Vercel API 주소
VERCEL_API_URL = "https://process-log.vercel.app/api/diff" # (실제 배포 주소로 변경)

UPLOAD_INTERVAL_SECONDS = 10 # 10초마다 폴더 확인
BATCH_SIZE = 2             # 2개씩 묶어 전송

# --- 설정 읽기 ---
def get_config():
    """ uploader_config.json에서 인증 토큰과 이메일을 읽어옵니다. """
    if not os.path.exists(CONFIG_FILE):
        return None, None
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            config = json.load(f)
            # 4단계에서 Electron이 이 파일에 토큰을 써줄 것입니다.
            auth_token = config.get('sessionToken') 
            user_email = config.get('userEmail') # (디버깅용, 실제 인증은 토큰으로)
            return auth_token, user_email
    except Exception as e:
        print(f"설정 파일 읽기 오류: {e}")
        return None, None

# --- API 전송 로직 ---
def send_screenshots(filepaths, auth_token, user_email):
    print(f"전송 시도: {len(filepaths)}개 파일...")
    
    payload_screenshots = []
    try:
        for path in filepaths:
            filename = os.path.basename(path)
            base64_data = encode_image_to_base64_data_uri(path)
            if base64_data:
                payload_screenshots.append({
                    "filename": filename,
                    "data": base64_data
                })
            else:
                print(f"파일 인코딩 실패: {path}")
                return False
                
    except Exception as e:
        print(f"파일 처리 중 오류: {e}")
        return False

    # (참고: userEmail은 4단계 API 인증 구현 시 제거될 수 있습니다)
    json_payload = {
        "screenshots": payload_screenshots,
    }

    # ★ 4단계에서 구현될 인증 헤더
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {auth_token}"
    }

    try:
        response = requests.post(VERCEL_API_URL, json=json_payload, headers=headers)
        
        if response.status_code == 200:
            print(f"전송 성공: {response.json().get('message')}")
            return True
        else:
            # (Q1 답변: 실패 시 대기열에 놔두므로 False 반환)
            print(f"전송 실패 (서버 응답 {response.status_code}): {response.text}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"네트워크 오류 (전송 실패): {e}")
        return False

# --- 메인 작업 ---
def job():
    print(f"[{time.strftime('%H:%M:%S')}] 업로드 작업 실행...")
    
    auth_token, user_email = get_config()
    
    # 4단계: 인증 토큰이 없으면 Electron이 아직 준비되지 않은 것
    if not auth_token:
        print("인증 토큰을 찾을 수 없습니다. (로그인 대기 중)")
        return

    os.makedirs(UPLOADED_DIR, exist_ok=True)
    
    try:
        # 'uploaded' 폴더 제외
        all_files = [
            f for f in os.listdir(SCREENSHOT_DIR) 
            if os.path.isfile(os.path.join(SCREENSHOT_DIR, f)) and f.endswith('.png')
        ]
        
        full_paths = [os.path.join(SCREENSHOT_DIR, f) for f in all_files]
        full_paths.sort(key=os.path.getmtime) # 생성 시간순 정렬

        if len(full_paths) >= BATCH_SIZE:
            files_to_send = full_paths[:BATCH_SIZE]
            
            if send_screenshots(files_to_send, auth_token, user_email):
                # 전송 성공 시 'uploaded' 폴더로 이동
                for path in files_to_send:
                    try:
                        shutil.move(path, os.path.join(UPLOADED_DIR, os.path.basename(path)))
                    except Exception as e:
                        print(f"파일 이동 오류: {e}")
            # (Q1 답변: 전송 실패 시(False 반환) 아무것도 하지 않고, 파일은 다음 job에서 재시도됨)
            
        else:
            print(f"전송 대기 파일 부족 (현재: {len(full_paths)}개)")
            
    except Exception as e:
        print(f"작업 중 오류 발생: {e}")

# --- 스케줄러 실행 ---
if __name__ == "__main__":
    print("--- 스크린샷 업로더 시작 ---")
    print(f"감시 대상: {SCREENSHOT_DIR}")
    print(f"전송 주기: {UPLOAD_INTERVAL_SECONDS}초")
    
    schedule.every(UPLOAD_INTERVAL_SECONDS).seconds.do(job)
    
    while True:
        try:
            schedule.run_pending()
            time.sleep(1)
        except KeyboardInterrupt:
            print("업로더 종료.")
            break