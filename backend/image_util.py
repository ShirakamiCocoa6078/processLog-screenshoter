# backend/image_util.py

import base64
import mimetypes # 파일 확장자로부터 MIME 타입을 추측

def encode_image_to_base64_data_uri(filepath):
    """
    이미지 파일을 읽어 data:image/png;base64,... 형식의 문자열로 변환합니다.
    """
    try:
        # 1. 파일의 MIME 타입 추측 (예: 'image/png')
        mime_type, _ = mimetypes.guess_type(filepath)
        if not mime_type or not mime_type.startswith('image'):
            print(f"MIME 타입을 알 수 없음: {filepath}")
            return None

        # 2. 파일을 바이너리로 읽기
        with open(filepath, 'rb') as image_file:
            binary_data = image_file.read()

        # 3. Base64로 인코딩 (bytes -> str)
        base64_encoded_string = base64.b64encode(binary_data).decode('utf-8')

        # 4. Data URI 형식으로 조합
        return f"data:{mime_type};base64,{base64_encoded_string}"
        
    except Exception as e:
        print(f"Base64 인코딩 오류 ({filepath}): {e}")
        return None