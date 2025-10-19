# backend/app.py

import threading
import time
import os
import mss
from mss import tools
from PIL import Image
from datetime import datetime
from flask import Flask, request, jsonify

app = Flask(__name__)

# --- 전역 변수 ---
screenshot_thread = None
is_running = False
thread_lock = threading.Lock()

# --- 스크린샷 저장 경로 설정 ---
# 이 파일(app.py)이 backend/ 폴더에 있으므로,
# 부모 폴더(프로젝트 루트)의 'screenshot' 폴더를 가리킵니다.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVE_PATH = os.path.join(BASE_DIR, 'screenshot')

# --- 스크린샷 캡처 루프 ---
def capture_loop(settings):
    global is_running
    print(f"캡처 스레드 시작. 설정: {settings}")
    
    interval = float(settings.get('interval', 5.0))
    resolution_scale = float(settings.get('resolution', 1.0))
    
    os.makedirs(SAVE_PATH, exist_ok=True)

    with mss.mss() as sct:
        while True:
            with thread_lock:
                if not is_running:
                    break
            
            try:
                # 파일명: screenshot_YYYY-MM-DD_HH-MM-SS.png
                timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
                filename = f"screenshot_{timestamp}.png"
                output_path = os.path.join(SAVE_PATH, filename)
                temp_output_path = os.path.join(SAVE_PATH, f"temp_{filename}")

                # 1. 전체 모니터 캡처 (가상 스크린)
                monitor = sct.monitors[0]
                sct_img = sct.grab(monitor)
                tools.to_png(sct_img.rgb, sct_img.size, output=temp_output_path)

                # 2. 해상도 조절 (Pillow)
                if resolution_scale != 1.0:
                    with Image.open(temp_output_path) as img:
                        width, height = img.size
                        new_size = (int(width * resolution_scale), int(height * resolution_scale))
                        resized_img = img.resize(new_size, Image.Resampling.LANCZOS)
                        resized_img.save(output_path)
                    os.remove(temp_output_path)
                else:
                    os.rename(temp_output_path, output_path)
                
                print(f"캡처 저장: {output_path}")

            except Exception as e:
                print(f"캡처 중 오류 발생: {e}")
            
            # 3. 다음 캡처까지 대기 (중지 플래그 확인 포함)
            elapsed = 0.0
            check_interval = 0.1
            while elapsed < interval:
                with thread_lock:
                    if not is_running:
                        break
                time.sleep(check_interval)
                elapsed += check_interval
                
    print("캡처 스레드 종료.")

# --- API 엔드포인트 ---

@app.route('/start', methods=['POST'])
def start_capturing():
    global screenshot_thread, is_running
    with thread_lock:
        if is_running:
            return jsonify({"status": "warning", "message": "이미 실행 중입니다."}), 400
        
        settings = request.get_json()
        if not settings:
            settings = {'interval': 5.0, 'resolution': 1.0}
            
        is_running = True
        screenshot_thread = threading.Thread(target=capture_loop, args=(settings,))
        screenshot_thread.start()
        
        return jsonify({"status": "success", "message": "스크린샷 캡처를 시작합니다."})

@app.route('/stop', methods=['POST'])
def stop_capturing():
    global screenshot_thread, is_running
    with thread_lock:
        if not is_running:
            return jsonify({"status": "warning", "message": "이미 중지되어 있습니다."}), 400
        
        print("중지 요청 수신...")
        is_running = False
    
    if screenshot_thread:
        screenshot_thread.join() # 스레드가 완전히 종료될 때까지 대기
        screenshot_thread = None
        
    print("캡처가 완전히 중지되었습니다.")
    return jsonify({"status": "success", "message": "스크린샷 캡처를 중지했습니다."})

if __name__ == '__main__':
    # Electron에서 자식 프로세스로 실행될 때 디버그 모드 및 리로더를 비활성화해야 합니다.
    app.run(port=5001, debug=False, use_reloader=False)