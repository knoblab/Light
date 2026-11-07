# SensorClean Web Deployment Package (정적 웹 배포 패키지)

이 폴더는 **SensorClean**을 웹 호스팅 서비스나 사내 웹 서버에 즉시 배포할 수 있도록 빌드된 순수 정적 웹 자산(Static Web Assets) 모음입니다.

서버 사이드 백엔드 설치 없이, 브라우저 내부에서 **Pure-Rust WebAssembly (`sc-wasm`)** 엔진이 동작하여 클라이언트 단독으로 카메라 RAW 디코딩, 센서 먼지 감지, 16비트 바이하모닉 인페인팅 복원, DNG/TIFF/JPEG 내보내기를 수행합니다.

---

## 📁 구성 파일 목록

- `index.html`: 웹 애플리케이션 진입점 (상대 경로 `./` 적용으로 루트 도메인 및 서브 디렉터리 모두 지원)
- `favicon.svg`: 앱 파비콘
- `assets/`:
  - `index-*.js`: React 19 UI 번들
  - `index-*.css`: 스타일시트
  - `sensorWorker-*.js`: 백그라운드 Web Worker
  - `sc_wasm_bg-*.wasm`: Pure-Rust 고성능 RAW 연산 WebAssembly 바이너리 (3.9 MB)
- `_headers`: Cloudflare Pages / Netlify 보안 및 브라우저 캐싱 설정 헤더
- `_redirects`: SPA 라우팅 규칙 (`/* /index.html 200`)

---

## 🚀 배포 방법 가이드

### 1. Cloudflare Pages
1. Cloudflare 대시보드 -> **Workers & Pages** -> **Create application** -> **Pages** -> **Upload assets** 선택.
2. 프로젝트 이름을 입력하고 이 `web` 폴더(또는 `SensorClean-v0.1.0-web.zip` 압축 해제 폴더)를 드래그 앤 드롭합니다.
3. **Deploy site** 버튼을 클릭하면 즉시 전 세계 CDN으로 배포 완료됩니다.

### 2. Netlify / Vercel
- **Netlify**: Netlify 대시보드의 **Sites** 화면 하단 "Drag and drop your site output folder here" 영역에 이 `web` 폴더를 드롭하면 10초 만에 배포됩니다.
- **Vercel**: CLI에서 `vercel deploy --prod` 명령어를 실행하거나 GitHub 레포지토리 연동 시 루트 디렉터리로 지정합니다.

### 3. GitHub Pages
1. GitHub 레포지토리의 `gh-pages` 브랜치에 이 폴더의 파일들을 커밋 & 푸시합니다.
2. 레포지토리 Settings -> Pages -> Source를 `Deploy from a branch` (gh-pages / root)로 지정합니다.
3. 상대 경로(`./assets/...`)로 구성되어 있으므로 `https://<username>.github.io/<repo>/` 서브경로에서도 완벽하게 동작합니다.

### 4. Nginx 웹 서버
`nginx.conf`의 server 블록에 다음과 같이 설정합니다:
```nginx
server {
    listen 80;
    server_name sensorclean.example.com;
    root /var/www/sensorclean/web;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.wasm$ {
        types { application/wasm wasm; }
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

### 5. 로컬 즉시 테스트
파이썬 또는 Node.js를 이용해 로컬에서 즉시 확인 가능합니다:
```bash
# Python 3
python3 -m http.server 8080 --directory .

# Node.js
npx serve .
```
브라우저에서 `http://localhost:8080`으로 접속하여 즉시 사용할 수 있습니다.
