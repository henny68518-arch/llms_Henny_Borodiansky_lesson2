import json
import logging
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from openai import OpenAI, OpenAIError
import httpx
from prompt_config import GRADING_PROMPT_TEMPLATE, PROMPT_VERSION

# =========== Config ===========
API_KEY = os.getenv("SAFEAI_API_KEY", "")
BASE_URL = "https://safeai613.com/v1"
logger = logging.getLogger(__name__)

# =========== FastAPI Setup ===========
app = FastAPI(title="SafeAI API", version="1.0.0")


# =========== CORS Middleware ===========
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:4200",  # הכתובת של אפליקציית Angular
        "http://localhost:5173",  # Vite development server
        "http://localhost:3000",  # Another common dev port
        "http://127.0.0.1:4200",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========== Models ===========
class GradeRequest(BaseModel):
    solution: str = Field(min_length=1, max_length=12000)


class GradeResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: int = Field(ge=0, le=100)
    feedback: str
    suggestions: list[str]


class StructuredOutputStreamParser:
    def __init__(self) -> None:
        self.buffer = ""
        self.position = 0
        self.state = "start"
        self.current_key = ""
        self.seen_keys: set[str] = set()
        self.string_target = ""
        self.string_position = 0
        self.suggestion_index = 0
        self.pending_high_surrogate: int | None = None

    def feed(self, delta: str) -> list[dict[str, object]]:
        self.buffer += delta
        return self._pump()

    def finish(self) -> GradeResult:
        self._pump()
        if self.state != "complete" or self.buffer[self.position:].strip():
            raise ValueError("Structured response ended before valid JSON was complete")
        return GradeResult.model_validate_json(self.buffer)

    def _skip_whitespace(self) -> None:
        while self.position < len(self.buffer) and self.buffer[self.position].isspace():
            self.position += 1

    def _read_json_string(self) -> tuple[str, int] | None:
        try:
            value, end = json.JSONDecoder().raw_decode(self.buffer, self.position)
        except json.JSONDecodeError:
            return None
        if not isinstance(value, str):
            raise ValueError("Expected a JSON string")
        return value, end

    def _pump(self) -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        while True:
            if self.state == "start":
                self._skip_whitespace()
                if self.position >= len(self.buffer):
                    break
                if self.buffer[self.position] != "{":
                    raise ValueError("Structured response must be a JSON object")
                self.position += 1
                self.state = "key"

            elif self.state == "key":
                self._skip_whitespace()
                if self.position >= len(self.buffer):
                    break
                if self.buffer[self.position] == "}":
                    self.position += 1
                    self.state = "complete"
                    continue
                parsed_key = self._read_json_string()
                if parsed_key is None:
                    break
                self.current_key, self.position = parsed_key
                if self.current_key not in {"score", "feedback", "suggestions"}:
                    raise ValueError("Structured response contains an unknown field")
                if self.current_key in self.seen_keys:
                    raise ValueError("Structured response contains a duplicate field")
                self.seen_keys.add(self.current_key)
                self.state = "colon"

            elif self.state == "colon":
                self._skip_whitespace()
                if self.position >= len(self.buffer):
                    break
                if self.buffer[self.position] != ":":
                    raise ValueError("Expected a colon after a JSON field name")
                self.position += 1
                self.state = "value"

            elif self.state == "value":
                self._skip_whitespace()
                if self.position >= len(self.buffer):
                    break
                if self.current_key == "score":
                    try:
                        value, end = json.JSONDecoder().raw_decode(
                            self.buffer, self.position
                        )
                    except json.JSONDecodeError:
                        break
                    if isinstance(value, bool) or not isinstance(value, int):
                        raise ValueError("Score must be an integer")
                    if end == len(self.buffer):
                        break
                    delimiter = self.buffer[end]
                    if delimiter not in ",} \t\r\n":
                        raise ValueError("Invalid score value")
                    self.position = end
                    events.append({"type": "score", "value": value})
                    self.state = "separator"
                elif self.current_key == "feedback":
                    if self.buffer[self.position] != '"':
                        raise ValueError("Feedback must be a string")
                    self.position += 1
                    self.string_position = self.position
                    self.string_target = "feedback"
                    self.state = "string"
                    events.append({"type": "feedback_start"})
                else:
                    if self.buffer[self.position] != "[":
                        raise ValueError("Suggestions must be an array")
                    self.position += 1
                    self.state = "suggestion"
                    events.append({"type": "suggestions_start"})

            elif self.state == "string":
                string_events, completed = self._read_string_delta()
                events.extend(string_events)
                if not completed:
                    break
                self.state = "separator" if self.string_target == "feedback" else "suggestion"

            elif self.state == "suggestion":
                self._skip_whitespace()
                if self.position >= len(self.buffer):
                    break
                char = self.buffer[self.position]
                if char == "]":
                    self.position += 1
                    events.append({"type": "suggestions_complete"})
                    self.state = "separator"
                elif char == ",":
                    self.position += 1
                elif char == '"':
                    self.position += 1
                    self.string_position = self.position
                    self.string_target = "suggestion"
                    events.append({
                        "type": "suggestion_start",
                        "index": self.suggestion_index,
                    })
                    self.suggestion_index += 1
                    self.state = "string"
                else:
                    raise ValueError("Each suggestion must be a string")

            elif self.state == "separator":
                self._skip_whitespace()
                if self.position >= len(self.buffer):
                    break
                char = self.buffer[self.position]
                if char == ",":
                    self.position += 1
                    self.state = "key"
                elif char == "}":
                    self.position += 1
                    self.state = "complete"
                else:
                    raise ValueError("Expected a comma or closing brace")

            elif self.state == "complete":
                break

        return events

    def _read_string_delta(self) -> tuple[list[dict[str, object]], bool]:
        chunks: list[str] = []
        while self.string_position < len(self.buffer):
            char = self.buffer[self.string_position]
            if char == '"':
                if self.pending_high_surrogate is not None:
                    raise ValueError("Unpaired Unicode surrogate in response")
                self.string_position += 1
                self.position = self.string_position
                event_type = (
                    "feedback_complete"
                    if self.string_target == "feedback"
                    else "suggestion_complete"
                )
                return self._string_events(chunks) + [{"type": event_type}], True
            if char != "\\":
                if self.pending_high_surrogate is not None:
                    raise ValueError("Unpaired Unicode surrogate in response")
                chunks.append(char)
                self.string_position += 1
                continue

            if self.string_position + 1 >= len(self.buffer):
                break
            escape = self.buffer[self.string_position + 1]
            simple_escapes = {
                '"': '"',
                "\\": "\\",
                "/": "/",
                "b": "\b",
                "f": "\f",
                "n": "\n",
                "r": "\r",
                "t": "\t",
            }
            if escape in simple_escapes:
                if self.pending_high_surrogate is not None:
                    raise ValueError("Unpaired Unicode surrogate in response")
                chunks.append(simple_escapes[escape])
                self.string_position += 2
                continue
            if escape != "u":
                raise ValueError("Invalid JSON string escape")
            end = self.string_position + 6
            if end > len(self.buffer):
                break
            digits = self.buffer[self.string_position + 2:end]
            try:
                codepoint = int(digits, 16)
            except ValueError as error:
                raise ValueError("Invalid Unicode escape") from error
            if 0xD800 <= codepoint <= 0xDBFF:
                if self.pending_high_surrogate is not None:
                    raise ValueError("Invalid Unicode surrogate pair")
                self.pending_high_surrogate = codepoint
            elif 0xDC00 <= codepoint <= 0xDFFF:
                if self.pending_high_surrogate is None:
                    raise ValueError("Unpaired Unicode surrogate in response")
                combined = (
                    0x10000
                    + ((self.pending_high_surrogate - 0xD800) << 10)
                    + codepoint
                    - 0xDC00
                )
                chunks.append(chr(combined))
                self.pending_high_surrogate = None
            else:
                if self.pending_high_surrogate is not None:
                    raise ValueError("Unpaired Unicode surrogate in response")
                chunks.append(chr(codepoint))
            self.string_position = end

        return self._string_events(chunks), False

    def _string_events(self, chunks: list[str]) -> list[dict[str, object]]:
        if not chunks:
            return []
        text = "".join(chunks)
        if self.string_target == "feedback":
            return [{"type": "feedback_delta", "delta": text}]
        return [{
            "type": "suggestion_delta",
            "index": self.suggestion_index - 1,
            "delta": text,
        }]


TEACHER_TASK = "כתוב פונקציה בשפת תכנות כלשהי."


def build_grading_input(request: GradeRequest) -> list[dict[str, str]]:
    prompt = GRADING_PROMPT_TEMPLATE.format(
        version=PROMPT_VERSION,
        teacher=TEACHER_TASK,
        student=request.solution,
    )
    return [{"role": "user", "content": prompt}]


# =========== Initialize Client ===========
httpx_client = httpx.Client(http2=True, verify=False)

client = OpenAI(
    base_url=BASE_URL,
    api_key=API_KEY,
    http_client=httpx_client
)

# =========== Routes ===========
@app.post("/grade", response_model=GradeResult)
async def grade_solution(request: GradeRequest):
    """Return a structured grade, feedback, and improvement suggestions."""
    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="SAFEAI_API_KEY is not set in the environment",
        )

    try:
        response = client.responses.create(
            model="gpt-4o-mini",
            input=build_grading_input(request),
            text={
                "format": {
                    "type": "json_schema",
                    "name": "exercise_grade",
                    "strict": True,
                    "schema": GradeResult.model_json_schema(),
                }
            },
        )
        if not response.output_text:
            raise ValueError("Structured grading response was empty")
        return GradeResult.model_validate_json(response.output_text)
    except (OpenAIError, ValidationError, ValueError) as error:
        logger.error("Structured grading request failed (%s)", type(error).__name__)
        raise HTTPException(
            status_code=502,
            detail="בדיקת התרגיל נכשלה",
        ) from error


@app.post("/grade/stream")
def grade_solution_stream(request: GradeRequest):
    """Stream structured grading fields as they arrive from the model."""
    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="SAFEAI_API_KEY is not set in the environment",
        )

    def event_stream():
        parser = StructuredOutputStreamParser()
        try:
            stream = client.responses.create(
                model="gpt-4o-mini",
                input=build_grading_input(request),
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "exercise_grade",
                        "strict": True,
                        "schema": GradeResult.model_json_schema(),
                    }
                },
                stream=True,
            )
            for event in stream:
                if event.type == "response.output_text.delta":
                    for parsed_event in parser.feed(event.delta):
                        data = json.dumps(parsed_event, ensure_ascii=False)
                        yield f"data: {data}\n\n"
                elif event.type in {"response.failed", "response.incomplete"}:
                    raise RuntimeError("The structured response did not complete")

            result = parser.finish()
            data = json.dumps(
                {"type": "done", "result": result.model_dump()},
                ensure_ascii=False,
            )
            yield f"data: {data}\n\n"
        except (OpenAIError, RuntimeError, ValueError) as error:
            logger.error("Structured grading stream failed (%s)", type(error).__name__)
            data = json.dumps(
                {"type": "error", "error": "בדיקת התרגיל נכשלה"},
                ensure_ascii=False,
            )
            yield f"data: {data}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
async def health_check():
    """
    Health check endpoint
    """
    return {"status": "healthy"}

# =========== Shutdown Event ===========
@app.on_event("shutdown")
async def shutdown_event():
    """
    Close httpx client on shutdown
    """
    httpx_client.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
