# SensorClean

카메라 RAW의 센서 먼지를 자동으로 찾아 복원하는 도구입니다. React 화면 + Express 서버 + Python(LibRaw/OpenCV) 엔진으로 구성됩니다.

개발 상태와 로드맵은 [docs/RAW_PRODUCTION_PLAN.md](docs/RAW_PRODUCTION_PLAN.md)를 참고하세요.

## 실행

필요한 것: Node.js 22 이상, Python 3.10–3.13 (또는 [uv](https://docs.astral.sh/uv/)).

```bash
npm install            # 또는 bun install
npm run setup:python   # .venv 생성 + 엔진 패키지 설치 (python/constraints.txt 버전 고정)
npm run dev            # http://127.0.0.1:3000
```

- 서버는 기본적으로 `127.0.0.1`에만 열립니다. 인증이 없으므로 외부 공개 전에는 반드시 별도 보호를 두세요. 설정은 [.env.example](.env.example)을 참고하세요.
- Python 엔진이 없으면 서버가 안내 메시지를 반환합니다. 이 경우 브라우저 대체 경로가 쓰이며, RAW는 카메라 내장 미리보기로만 열리고 DNG 내보내기는 비활성화됩니다.

## 검증

```bash
npm run lint                  # tsc --noEmit
npm test                      # vitest (DNG/TIFF 저장기, ICC, 내보내기 정책)
.venv/Scripts/python -m pytest python/tests    # Windows
.venv/bin/python -m pytest python/tests        # macOS/Linux
```

테스트용 의존성은 `npm run setup:python -- --dev`로 설치합니다.

## 구조

| 경로 | 역할 |
|---|---|
| `server.ts` | Express API, 세션 관리, Python 작업 프로세스 연결 |
| `python/raw_pipeline.py` | RAW 디코딩, 먼지 검출, 복원, 내보내기 |
| `src/` | React 화면, 브라우저 대체 엔진(Web Worker) |
| `docs/` | 분석·계획 문서 |

## 라이선스

AGPL-3.0 ([LICENSE](LICENSE))
