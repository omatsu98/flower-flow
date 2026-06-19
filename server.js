const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const dataFile = path.join(dataDir, "flower-flow-state.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/state" && req.method === "GET") {
      const state = await readState();
      sendJson(res, state || null);
      return;
    }

    if (url.pathname === "/api/state" && req.method === "PUT") {
      const body = await readBody(req);
      const state = JSON.parse(body || "{}");
      await writeState(state);
      sendJson(res, { ok: true, savedAt: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/ocr" && req.method === "POST") {
      if (!process.env.OPENAI_API_KEY) {
        sendJson(res, {
          ok: false,
          error: "画像読取にはサーバーのOPENAI_API_KEY設定が必要です。",
        }, 503);
        return;
      }

      const body = JSON.parse(await readBody(req) || "{}");
      const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
      const mode = body.mode === "sales" ? "sales" : "inventory";
      if (!images.length || images.some((image) => !isSupportedImageDataUrl(image))) {
        sendJson(res, { ok: false, error: "読取可能な画像を選択してください。" }, 400);
        return;
      }

      const result = mode === "sales"
        ? await extractSalesFromImages(images)
        : await extractInventoryFromImages(images);
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, { ok: true });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: error.message || "Server error" }));
  }
});

server.listen(port, host, () => {
  console.log(`Flower Flow is running at http://${host}:${port}/`);
});

async function readState() {
  try {
    const text = await fs.readFile(dataFile, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(dataFile, payload, "utf8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25_000_000) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function serveStatic(urlPath, res) {
  const decodedPath = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const target = path.normalize(path.join(root, decodedPath));
  if (!target.startsWith(root)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }

  try {
    const contents = await fs.readFile(target);
    const type = mimeTypes[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": type.includes("text/html") ? "no-cache" : "public, max-age=3600",
    });
    res.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("Not found"), { statusCode: 404 });
    }
    throw error;
  }
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function isSupportedImageDataUrl(value) {
  return typeof value === "string" && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value);
}

async function extractInventoryFromImages(images) {
  const content = [
    {
      type: "input_text",
      text: [
        "あなたは日本の花屋が使うスプレッドシート形式の在庫表を正確に読み取る担当者です。",
        "各画像から店舗名、日付、左端または店舗名直下の色付き縦列に並ぶ花材・商品名と単価だけを抽出してください。",
        "右側の日別グリッドにある在庫、返品、納品、売上、繰越などの数字は商品名や単価として抽出しないでください。",
        "日付、年、曜日、JA転送、列見出し、単独の在庫数は商品として抽出しないでください。",
        "商品文字列の末尾にある数字は単価です。例: 樒1,500 は花材名=樒、単価=1500です。",
        "①②③④⑤などの丸数字は種類の区別なので花材名に残してください。例: 榊②400 は花材名=榊②、単価=400です。",
        "シまたはしの一文字・略記で始まる商品は樒に展開してください。例: し③180 は花材名=樒③、単価=180です。",
        "ビまたはびの一文字・略記で始まる商品はビシャコに展開してください。例: び①150 は花材名=ビシャコ①、単価=150です。",
        "画像ごとに1つのsheetとして返し、別画像の店舗や商品を勝手にまとめないでください。",
        "読めない文字は推測せず、noteに不明点を書いてください。",
      ].join("\n"),
    },
    ...images.map((image) => ({ type: "input_image", image_url: image, detail: "high" })),
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini",
      input: [{ role: "user", content }],
      max_output_tokens: 2000,
      text: {
        format: {
          type: "json_schema",
          name: "flower_inventory_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              sheets: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    store_name: { type: "string" },
                    document_date: {
                      type: "string",
                      description: "画像内の日付。判別できる場合はYYYY-MM-DD、できない場合は空文字。",
                    },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          raw_text: { type: "string" },
                          flower_name: { type: "string" },
                          unit_price: { type: "number" },
                          confidence: { type: "number" },
                          note: { type: "string" },
                        },
                        required: ["raw_text", "flower_name", "unit_price", "confidence", "note"],
                      },
                    },
                  },
                  required: ["store_name", "document_date", "items"],
                },
              },
              warnings: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["sheets", "warnings"],
          },
        },
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error && payload.error.message ? payload.error.message : "画像の読取に失敗しました。";
    throw Object.assign(new Error(message), { statusCode: response.status });
  }

  const text = extractResponseText(payload);
  if (!text) throw new Error("画像から読取結果を取得できませんでした。");
  return JSON.parse(text);
}

async function extractSalesFromImages(images) {
  const content = [
    {
      type: "input_text",
      text: [
        "あなたは日本の花屋の売上帳票を正確に読み取る担当者です。",
        "画像から帳票の日付、店舗名、店舗ごとの売上金額、販売数量を抽出してください。",
        "売上・売上金額・合計と明記された列を優先してください。",
        "在庫、返品、納品、繰越の数字を売上金額と混同しないでください。",
        "金額のカンマや円記号は除いて数値にしてください。",
        "販売数量が不明な場合は0、日付や店舗名が不明な場合は空文字にしてください。",
        "読めない内容を推測せず、noteまたはwarningsに不明点を書いてください。",
        "複数画像に同じ店舗があっても勝手に合算せず、それぞれの読取結果を残してください。",
      ].join("\n"),
    },
    ...images.map((image) => ({ type: "input_image", image_url: image, detail: "high" })),
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini",
      input: [{ role: "user", content }],
      max_output_tokens: 2000,
      text: {
        format: {
          type: "json_schema",
          name: "flower_sales_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              document_date: {
                type: "string",
                description: "帳票の日付。判別できる場合はYYYY-MM-DD、できない場合は空文字。",
              },
              stores: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    store_name: { type: "string" },
                    sales_amount: { type: "number" },
                    sold_quantity: { type: "number" },
                    confidence: { type: "number" },
                    note: { type: "string" },
                  },
                  required: ["store_name", "sales_amount", "sold_quantity", "confidence", "note"],
                },
              },
              warnings: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["document_date", "stores", "warnings"],
          },
        },
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error && payload.error.message ? payload.error.message : "売上画像の読取に失敗しました。";
    throw Object.assign(new Error(message), { statusCode: response.status });
  }

  const text = extractResponseText(payload);
  if (!text) throw new Error("売上画像から読取結果を取得できませんでした。");
  return JSON.parse(text);
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return "";
}
