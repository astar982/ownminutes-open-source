export class BoundedRequestError extends Error {
  readonly code: "invalid_request_body" | "request_body_too_large";
  readonly status: 400 | 413;

  constructor(code: BoundedRequestError["code"], message: string) {
    super(message);
    this.name = "BoundedRequestError";
    this.code = code;
    this.status = code === "request_body_too_large" ? 413 : 400;
  }
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw new BoundedRequestError("invalid_request_body", "请求体不能为空。");
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedRequestError("invalid_request_body", "请求体不是有效 JSON。");
  }
}

export async function readBoundedOptionalJson(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) return {};

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedRequestError("invalid_request_body", "请求体不是有效 JSON。");
  }
}

export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new BoundedRequestError("invalid_request_body", "请求体必须是 multipart/form-data。");
  }
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw new BoundedRequestError("invalid_request_body", "请求体不能为空。");
  }

  try {
    return await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new BoundedRequestError("invalid_request_body", "表单内容无效。");
  }
}

export async function readBoundedAuthBody(
  request: Request,
  options: {
    maxBytes?: number;
    maxEntries?: number;
    maxFieldNameLength?: number;
    maxFieldValueLength?: number;
  } = {},
) {
  const maxBytes = options.maxBytes ?? 32 * 1024;
  const maxEntries = options.maxEntries ?? 12;
  const maxFieldNameLength = options.maxFieldNameLength ?? 64;
  const maxFieldValueLength = options.maxFieldValueLength ?? 2048;
  const contentType = request.headers.get("content-type") ?? "";
  const normalizedContentType = contentType.toLowerCase();
  const bytes = await readBoundedBody(request, maxBytes);
  let entries: Array<[string, string]>;
  let isFormRequest = true;

  if (normalizedContentType.includes("application/json")) {
    isFormRequest = false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new BoundedRequestError("invalid_request_body", "请求体不是有效 JSON。");
    }
    if (!isPlainRecord(parsed)) {
      throw new BoundedRequestError("invalid_request_body", "请求体必须是 JSON 对象。");
    }
    entries = Object.entries(parsed).map(([key, value]) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
        throw new BoundedRequestError("invalid_request_body", "认证字段必须是文本值。");
      }
      return [key, value === null ? "" : String(value)];
    });
  } else if (normalizedContentType.includes("application/x-www-form-urlencoded") || !contentType) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new BoundedRequestError("invalid_request_body", "表单编码无效。");
    }
    entries = [...new URLSearchParams(text).entries()];
  } else if (normalizedContentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new BoundedRequestError("invalid_request_body", "表单内容无效。");
    }
    entries = [...formData.entries()].map(([key, value]) => {
      if (typeof value !== "string") {
        throw new BoundedRequestError("invalid_request_body", "认证表单不接受文件。");
      }
      return [key, value];
    });
  } else {
    throw new BoundedRequestError("invalid_request_body", "不支持的请求类型。");
  }

  if (entries.length > maxEntries) {
    throw new BoundedRequestError("invalid_request_body", "请求字段过多。");
  }
  for (const [key, value] of entries) {
    if (!key || key.length > maxFieldNameLength || value.length > maxFieldValueLength) {
      throw new BoundedRequestError("invalid_request_body", "请求字段长度超出限制。");
    }
  }

  return {
    body: Object.fromEntries(entries),
    isFormRequest,
  };
}

export function requirePlainRecord(value: unknown, message = "请求体必须是 JSON 对象。"): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new BoundedRequestError("invalid_request_body", message);
  }
  return value;
}

export function boundedString(
  value: unknown,
  options: {
    field: string;
    maxLength: number;
    required?: boolean;
    trim?: boolean;
  },
) {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new BoundedRequestError("invalid_request_body", `${options.field} 不能为空。`);
    }
    return "";
  }
  if (typeof value !== "string") {
    throw new BoundedRequestError("invalid_request_body", `${options.field} 必须是文本。`);
  }
  if (value.length > options.maxLength) {
    throw new BoundedRequestError("invalid_request_body", `${options.field} 长度超出限制。`);
  }
  const normalized = options.trim === false ? value : value.trim();
  if (options.required && !normalized) {
    throw new BoundedRequestError("invalid_request_body", `${options.field} 不能为空。`);
  }
  return normalized;
}

export async function readBoundedBody(request: Request, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new BoundedRequestError("invalid_request_body", "Content-Length 无效。");
    }
    if (declared > maxBytes) {
      throw new BoundedRequestError("request_body_too_large", "请求体过大。");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body exceeded limit").catch(() => undefined);
        throw new BoundedRequestError("request_body_too_large", "请求体过大。");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (contentLength && totalBytes !== Number(contentLength)) {
    throw new BoundedRequestError("invalid_request_body", "请求体长度与 Content-Length 不一致。");
  }
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
