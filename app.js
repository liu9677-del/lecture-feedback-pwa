// ===== 設定區：填入您自己的值 =====
const CONFIG = {
  GOOGLE_CLIENT_ID: '268559654361-dkc7pshurgb6l8i6ms5nckqgl4dhet2r.apps.googleusercontent.com',
  GEMINI_MODEL: 'gemini-3.6-flash',
};
// ===================================

let mediaRecorder;
let audioChunks = [];
let driveAccessToken = null;
let jobCounter = 0;

const statusEl = document.getElementById('status');
const reportsEl = document.getElementById('reports'); // 改為多筆報告容器
const recordBtn = document.getElementById('recordBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const geminiKeyInput = document.getElementById('geminiKey');
const driveAuthBtn = document.getElementById('driveAuthBtn');
const driveStatusEl = document.getElementById('driveStatus');

geminiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
geminiKeyInput.addEventListener('change', () => {
  localStorage.setItem('gemini_api_key', geminiKeyInput.value);
});

function log(msg) {
  statusEl.textContent += msg + '\n';
}

// ---------- 錄音：錄完立刻可以錄下一場，不用等分析 ----------
recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    recordBtn.textContent = '開始錄音';
    recordBtn.classList.remove('recording');
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    stream.getTracks().forEach((t) => t.stop());
    queueAnalysis(blob, `錄音 ${new Date().toLocaleTimeString('zh-TW')}`);
  };
  mediaRecorder.start();
  recordBtn.textContent = '停止錄音（可馬上錄下一場）';
  recordBtn.classList.add('recording');
  log('錄音中...');
});

// ---------- 上傳檔案：一樣立刻進佇列，不卡住介面 ----------
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    queueAnalysis(file, file.name);
    fileInput.value = '';
  }
});

// ---------- Google Drive 授權 ----------
let tokenClient;
window.addEventListener('load', () => {
  if (window.google && google.accounts) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (resp) => {
        driveAccessToken = resp.access_token;
        driveStatusEl.textContent = '✅ 已連接 Google Drive';
      },
    });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
  }
});

driveAuthBtn.addEventListener('click', () => {
  if (tokenClient) tokenClient.requestAccessToken();
});

// ---------- Gemini 呼叫 ----------
function apiKey() {
  const key = geminiKeyInput.value.trim();
  if (!key) throw new Error('請先在下方填入 Gemini API Key');
  return key;
}

async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!res.ok) throw new Error(`Gemini API 錯誤: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function transcribeAudio(blob) {
  const base64 = await blobToBase64(blob);
  const mimeType = blob.type || 'audio/webm';
  return callGemini([
    { text: '請將這段醫學演講/會議的音訊完整轉成逐字稿（繁體中文與英文醫學術語混雜請如實保留），並適當分段。只輸出逐字稿內容。' },
    { inline_data: { mime_type: mimeType, data: base64 } },
  ]);
}

async function extractClaims(transcript) {
  const text = await callGemini([
    {
      text: `你是一位醫學研究助理。請閱讀以下演講逐字稿，萃取出講者提出的「核心論點」與「引用的關鍵數據/研究」，最多列出 8 點。
針對 search_keywords，請同時提供中文與英文兩種關鍵字（各1-2個），因為文獻庫可能是英文檔名或內容。
只輸出 JSON 陣列，格式為：
[{"claim": "論點摘要", "detail": "相關細節或數字", "search_keywords": ["中文關鍵字", "English keyword"]}]
不要輸出其他文字。

逐字稿：
${transcript}`,
    },
  ]);
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function compareClaimWithLiterature(claim, literature) {
  const literatureText = literature
    .map((f, i) => `[文獻${i + 1}] ${f.title}\n片段：${f.snippet}`)
    .join('\n\n');
  return callGemini([
    {
      text: `你是一位資深醫學研究者，正在幫使用者針對演講內容做文獻查核與評論。

演講論點：${claim.claim}
細節：${claim.detail}

使用者雲端硬碟中搜尋到的相關文獻：
${literatureText || '（未搜尋到相關文獻）'}

請針對這個論點給出簡短評論（3-5句），需包含：
1. 是否有文獻支持、有疑慮、或可補充最新資訊
2. 明確標註根據哪一篇文獻（用[文獻N]標示）
3. 若無對應文獻，請如實說明「文庫中無直接對應文獻」，並改為根據你自己的醫學知識給出一般性評論，不要留白

只輸出評論文字。`,
    },
  ]);
}

// ---------- Google Drive 搜尋：中英文關鍵字都搜 ----------
async function searchLiterature(keywords, maxResults = 5) {
  if (!driveAccessToken) return [];
  const q = keywords.map((k) => `fullText contains '${k.replace(/'/g, "\\'")}'`).join(' or ');
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=files(id,name,mimeType)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
  if (!res.ok) return [];
  const data = await res.json();
  const files = data.files || [];

  const results = [];
  for (const file of files) {
    try {
      const contentRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: { Authorization: `Bearer ${driveAccessToken}` } }
      );
      const text = contentRes.ok ? await contentRes.text() : '';
      results.push({ title: file.name, snippet: text.slice(0, 800) });
    } catch (e) {
      results.push({ title: file.name, snippet: '（無法讀取內容）' });
    }
  }
  return results;
}

// ---------- 佇列系統：每場演講各自跑，互不卡住 ----------
const jobQueue = [];
let isProcessing = false;

function queueAnalysis(blob, label) {
  jobCounter++;
  const jobId = jobCounter;
  const card = createReportCard(jobId, label);
  reportsEl.prepend(card); // 新的放最上面
  jobQueue.push({ jobId, blob, label });
  log(`已加入分析佇列：${label}（目前排隊 ${jobQueue.length} 筆）`);
  processQueue();
}

function createReportCard(jobId, label) {
  const card = document.createElement('div');
  card.id = `report-${jobId}`;
  card.className = 'report-card';
  card.innerHTML = `<div class="report-header">⏳ ${label}｜排隊中...</div><div class="report-body"></div>`;
  return card;
}

function updateCard(jobId, headerText, bodyHtml) {
  const card = document.getElementById(`report-${jobId}`);
  if (!card) return;
  card.querySelector('.report-header').textContent = headerText;
  if (bodyHtml !== undefined) card.querySelector('.report-body').textContent = bodyHtml;
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    await runOneAnalysis(job);
  }
  isProcessing = false;
}

async function runOneAnalysis({ jobId, blob, label }) {
  try {
    updateCard(jobId, `🔄 ${label}｜正在轉錄音訊...`);
    const transcript = await transcribeAudio(blob);

    updateCard(jobId, `🔄 ${label}｜正在萃取核心論點...`);
    const claims = await extractClaims(transcript);

    let md = '';
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      updateCard(jobId, `🔄 ${label}｜比對第 ${i + 1}/${claims.length} 個論點`);
      const literature = await searchLiterature(claim.search_keywords || [claim.claim]);
      const comment = await compareClaimWithLiterature(claim, literature);
      md += `【${i + 1}】${claim.claim}\n細節：${claim.detail}\n意見：${comment}\n`;
      if (literature.length) md += `參考文獻：${literature.map((l) => l.title).join('、')}\n`;
      md += '\n';
    }

    updateCard(jobId, `✅ ${label}｜完成`, md);
  } catch (err) {
    updateCard(jobId, `❌ ${label}｜錯誤：${err.message}`, '');
  }
}
