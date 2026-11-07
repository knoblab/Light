use thiserror::Error;

pub type Result<T> = std::result::Result<T, ScError>;

#[derive(Debug, Error)]
pub enum ScError {
    #[error("지원되지 않는 파일 또는 내보내기 형식입니다: {0}")]
    UnsupportedFormat(String),

    #[error("손상되었거나 읽을 수 없는 이미지/RAW 데이터입니다: {0}")]
    CorruptInput(String),

    #[error("RAW 디코더 내부 오류(격리됨): {0}")]
    DecoderPanic(String),

    #[error("세션을 찾을 수 없습니다: {0}")]
    SessionNotFound(String),

    #[error("유효하지 않은 매개변수입니다: {0}")]
    InvalidArgument(String),

    #[error("파이프라인 실행 오류: {0}")]
    Pipeline(String),

    #[error("입출력 오류: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 직렬화 오류: {0}")]
    Json(#[from] serde_json::Error),
}

impl ScError {
    pub fn code(&self) -> &'static str {
        match self {
            ScError::UnsupportedFormat(_) => "UNSUPPORTED_FORMAT",
            ScError::CorruptInput(_) => "CORRUPT_INPUT",
            ScError::DecoderPanic(_) => "DECODER_PANIC",
            ScError::SessionNotFound(_) => "SESSION_NOT_FOUND",
            ScError::InvalidArgument(_) => "INVALID_ARGUMENT",
            ScError::Pipeline(_) => "PIPELINE_ERROR",
            ScError::Io(_) => "IO_ERROR",
            ScError::Json(_) => "JSON_ERROR",
        }
    }
}
