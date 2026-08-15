export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;

  constructor(
    status: number,
    message: string,
    options?: { type?: string; code?: string | null },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = options?.type ?? "invalid_request_error";
    this.code = options?.code ?? null;
  }
}

export type OpenAIErrorBody = {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
};

export function openaiErrorBody(err: HttpError): OpenAIErrorBody {
  return {
    error: {
      message: err.message,
      type: err.type,
      code: err.code,
    },
  };
}

export function notImplemented(what: string): HttpError {
  return new HttpError(501, `${what} is not supported`, {
    type: "invalid_request_error",
    code: "unsupported",
  });
}
