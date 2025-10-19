# backend/uploader.py

import os
import time
import schedule
import requests
import json
import shutil
# image_util 임포트는 그대로 유지
from image_util import encode_image_to_base64_data_uri

# --- 설정 (기존과 동일) ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENSHOT_DIR = os.path.join(BASE_DIR, 'screenshot')
UPLOADED_DIR = os.path.join(SCREENSHOT_DIR, 'uploaded')
CONFIG_FILE = os.path.join(BASE_DIR, 'uploader_config.json')
VERCEL_API_URL = "https://process-log.vercel.app/api/diff"
UPLOAD_INTERVAL_SECONDS = 5 # 테스트를 위해 5초로 유지 (원하면 10초로 변경)
BATCH_SIZE = 2

# --- API 전송 로직 (수정: auth_token, user_email 인자 추가) ---
def send_screenshots(filepaths, auth_token, user_email): # user_email은 디버깅용
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

    json_payload = { "screenshots": payload_screenshots }
    headers = {
        "Content-Type": "application/json",
        # 헤더에 토큰 포함 (user_email은 보내지 않음)
        "Authorization": f"Bearer {auth_token}"
    }

    try:
        response = requests.post(VERCEL_API_URL, json=json_payload, headers=headers)
        if response.status_code == 200:
            print(f"전송 성공: {response.json().get('message')}")
            return True
        else:
            print(f"전송 실패 (서버 응답 {response.status_code}): {response.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"네트워크 오류 (전송 실패): {e}")
        return False

# --- 메인 작업 함수 (수정) ---
def job():
    print(f"[{time.strftime('%H:%M:%S')}] 업로드 작업 실행...")

    # --- 👇 [수정] 파일 개수 확인을 맨 위로 이동 ---
    try:
        # uploaded 폴더 제외하고 .png 파일만 필터링
        all_files = [
            f for f in os.listdir(SCREENSHOT_DIR)
            if os.path.isfile(os.path.join(SCREENSHOT_DIR, f)) and f.endswith('.png')
        ]

        # 파일 개수가 BATCH_SIZE보다 적으면 바로 종료
        if len(all_files) < BATCH_SIZE:
            print(f"전송 대기 파일 부족 (현재: {len(all_files)}개). 작업을 건너뜁니다.")
            return # 함수 종료

    except FileNotFoundError:
        # 스크린샷 폴더가 없으면 생성 시도 후 종료 (다음 실행 시 재시도)
        print(f"스크린샷 폴더({SCREENSHOT_DIR}) 없음. 폴더 생성 시도 후 건너뜁니다.")
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            os.makedirs(UPLOADED_DIR, exist_ok=True) # uploaded 폴더도 같이 생성
        except Exception as mkdir_e:
            print(f"폴더 생성 실패: {mkdir_e}")
        return # 함수 종료
    except Exception as e:
        print(f"파일 스캔 중 오류 발생 (작업 중단): {e}")
        return # 함수 종료
    # --- [수정 끝] ---

    # --- (파일 개수가 충분할 때만 아래 로직 실행) ---

    # 설정 파일 읽기 (토큰 및 삭제 옵션)
    should_delete = False
    auth_token = None
    user_email = None # 디버깅용

    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
                should_delete = bool(config.get('deleteAfterUpload', False))
                auth_token = config.get('sessionToken')
                user_email = config.get('userEmail') # (선택적)
        except Exception as e:
            print(f'uploader_config.json 읽기 오류: {e}')

    print(f"현재 설정: 전송 후 삭제 = {should_delete}")

    # 토큰 확인 (파일 개수 확인 이후)
    if not auth_token:
        print("인증 토큰을 찾을 수 없습니다 (uploader_config.json). 로그인 상태를 확인하세요.")
        return # 토큰 없으면 종료

    # uploaded 폴더 존재 확인 (위에서 생성 시도했으므로 여기선 필요시 한번 더 확인)
    os.makedirs(UPLOADED_DIR, exist_ok=True)

    try:
        # 파일 목록 다시 생성 및 정렬 (개수 확인 이후이므로 안전)
        # 여기서 all_files 변수를 재사용합니다.
        full_paths = [os.path.join(SCREENSHOT_DIR, f) for f in all_files]
        full_paths.sort(key=os.path.getmtime) # 생성(수정) 시간순 정렬

        # 전송할 파일 선택 (가장 오래된 BATCH_SIZE 개)
        files_to_send = full_paths[:BATCH_SIZE]

        # API 전송 시도
        if send_screenshots(files_to_send, auth_token, user_email):
            # 전송 성공 시 삭제 또는 이동
            if should_delete:
                print(f"삭제 모드 활성. 전송된 {len(files_to_send)}개 파일 삭제 시도...")
                for path in files_to_send:
                    try:
                        os.remove(path)
                        print(f"삭제 완료: {os.path.basename(path)}")
                    except Exception as e:
                        print(f"삭제 실패: {os.path.basename(path)} - {e}")
            else:
                print(f"이동 모드 활성. 전송된 {len(files_to_send)}개 파일 이동 시도...")
                for path in files_to_send:
                    try:
                        dest = os.path.join(UPLOADED_DIR, os.path.basename(path))
                        shutil.move(path, dest)
                        print(f"이동 완료: {os.path.basename(path)} -> uploaded")
                    except Exception as e:
                        print(f"이동 실패: {os.path.basename(path)} - {e}")
        else:
            print("전송 실패. 파일 처리 안 함.")

    except Exception as e:
        print(f"파일 전송/처리 중 오류 발생: {e}")

# --- 스케줄러 실행 (기존과 동일) ---
if __name__ == "__main__":
    print("--- 스크린샷 업로더 시작 ---")
    print(f"감시 대상: {SCREENSHOT_DIR}")
    print(f"전송 주기: {UPLOAD_INTERVAL_SECONDS}초")

    # 시작 시 폴더 생성 시도 (선택적이지만 권장)
    try:
        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        os.makedirs(UPLOADED_DIR, exist_ok=True)
    except Exception as e:
        print(f"시작 시 폴더 생성 실패 (무시 가능): {e}")

    schedule.every(UPLOAD_INTERVAL_SECONDS).seconds.do(job)

    while True:
        try:
            schedule.run_pending()
            time.sleep(1)
        except KeyboardInterrupt:
            print("업로더 종료 중...")
            break