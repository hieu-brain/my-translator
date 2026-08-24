/**
 * Lớp engine dịch — chạy trong service worker (import từ background.js).
 *
 * Cả hai engine đều nhận một LÔ câu và trả về mảng {i, vi}. Dùng structured
 * output ở cả hai phía để không phải parse text tự do — model trả sai định dạng
 * là lỗi ở tầng API, không phải bug thầm lặng ở tầng parse.
 */

/** Model nào nhận tham số nào. Sai là API trả 400. */
const ANTHROPIC_CAPS = {
  'claude-opus-5': { effort: true, canDisableThinking: true },
  'claude-sonnet-5': { effort: true, canDisableThinking: true },
  'claude-haiku-4-5': { effort: false, canDisableThinking: false },
};

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          vi: { type: 'string' },
        },
        required: ['i', 'vi'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function systemPrompt(cfg) {
  return [
    `Bạn dịch phụ đề cuộc họp CNTT từ ${cfg.sourceLang} sang ${cfg.targetLang} theo thời gian thực.`,
    '',
    'Quy tắc:',
    '- Dịch từng câu được đánh số, trả về đúng số thứ tự đó. Không gộp, không bỏ câu nào.',
    '- Giữ nguyên thuật ngữ kỹ thuật, tên riêng, tên sản phẩm, số hiệu ticket.',
    '- Văn phong nói chuyện công việc: tự nhiên, ngắn gọn, không trang trọng quá mức.',
    '- Câu có thể bị cắt giữa chừng hoặc nhận dạng sai. Dịch phần hiểu được, đừng bịa thêm.',
    '- Dùng ngữ cảnh phía trước để dịch đúng đại từ và chủ ngữ bị lược.',
    '- Chỉ trả về bản dịch, không giải thích, không thẻ XML nội bộ.',
    cfg.glossary ? `\nThuật ngữ bắt buộc dùng:\n${cfg.glossary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function userPrompt({ items, context }) {
  const parts = [];
  if (context?.length) {
    parts.push('<ngu_canh_truoc>');
    for (const c of context) {
      parts.push(`${c.name || '???'}: ${c.ja}${c.vi ? `\n  → ${c.vi}` : ''}`);
    }
    parts.push('</ngu_canh_truoc>', '');
  }
  parts.push('<can_dich>');
  for (const it of items) {
    parts.push(`[${it.id}] ${it.name || '???'}: ${it.ja}`);
  }
  parts.push('</can_dich>');
  return parts.join('\n');
}

/** Lỗi có thể thử lại (429 / 5xx). */
class RetryableError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

async function readError(res, fallbackMap = {}) {
  let detail = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    detail = j?.error?.message || j?.error?.status || detail;
  } catch {}
  return fallbackMap[res.status] || detail;
}

const Engines = {
  anthropic: {
    label: 'Anthropic',
    async translate(cfg, payload) {
      const caps = ANTHROPIC_CAPS[cfg.model] || {
        effort: false,
        canDisableThinking: false,
      };

      const outputConfig = {
        format: { type: 'json_schema', schema: BATCH_SCHEMA },
      };
      // effort không tồn tại trên Haiku 4.5 — gửi vào là 400.
      if (caps.effort) outputConfig.effort = 'low';

      const body = {
        model: cfg.model,
        max_tokens: 2048,
        system: systemPrompt(cfg),
        messages: [{ role: 'user', content: userPrompt(payload) }],
        output_config: outputConfig,
      };
      if (caps.canDisableThinking) body.thinking = { type: 'disabled' };

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(
          `Anthropic ${res.status}`,
          Number(res.headers.get('retry-after')) * 1000 || 0,
        );
      }
      if (!res.ok) {
        throw new Error(
          await readError(res, {
            401: 'Anthropic API key sai hoặc chưa nhập (mở Cài đặt)',
            403: 'API key không có quyền dùng model này',
          }),
        );
      }

      const data = await res.json();
      if (data.stop_reason === 'refusal') {
        throw new Error('Model từ chối dịch đoạn này');
      }
      const text = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return parseItems(text);
    },
  },

  gemini: {
    label: 'Google Gemini',
    async translate(cfg, payload) {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(cfg.geminiModel)}:generateContent`;

      const body = {
        systemInstruction: { parts: [{ text: systemPrompt(cfg) }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(payload) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(BATCH_SCHEMA),
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': cfg.geminiKey,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`Gemini ${res.status}`, 0);
      }
      if (!res.ok) {
        throw new Error(
          await readError(res, {
            400: 'Gemini từ chối request — kiểm tra tên model trong Cài đặt',
            403: 'Google API key sai hoặc chưa bật Generative Language API',
          }),
        );
      }

      const data = await res.json();
      const cand = data.candidates?.[0];
      if (cand?.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
        throw new Error(`Gemini dừng: ${cand.finishReason}`);
      }
      const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
      return parseItems(text);
    },
  },
};

/** JSON Schema → OpenAPI subset mà Gemini chấp nhận (type viết hoa, bỏ additionalProperties). */
function toGeminiSchema(schema) {
  const out = { type: String(schema.type).toUpperCase() };
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

function parseItems(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Model trả về JSON không hợp lệ');
  }
  const items = parsed?.items;
  if (!Array.isArray(items)) throw new Error('Thiếu mảng "items" trong kết quả');
  return items
    .filter((x) => Number.isInteger(x?.i) && typeof x?.vi === 'string')
    .map((x) => ({ i: x.i, vi: x.vi.trim() }));
}

export { Engines, RetryableError };
