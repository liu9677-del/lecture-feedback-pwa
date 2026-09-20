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
const reportsEl = document.getElementById('reports');
const recordBtn = document.getElementById('recordBtn');
const clearBtn = document.getElementById('clearBtn');
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

// ---------- 錄音 ----------
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

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    queueAnalysis(file, file.name);
    fileInput.value = '';
  }
});

// ---------- 清除全部暫存記錄 ----------
clearBtn.addEventListener('click', () => {
  const pending = jobQueue.length + (isProcessing ? 1 : 0);
  const warnMsg = pending > 0
    ? `目前還有 ${pending} 筆正在處理中，清除畫面不會中斷背景分析，但結果跑完後會找不到對應卡片顯示。確定要清除嗎？`
    : '確定要清除目前畫面上所有的逐字稿與報告記錄嗎？此動作無法復原。';
  if (!confirm(warnMsg)) return;
  reportsEl.innerHTML = '';
  statusEl.textContent = '';
  log('已清除畫面上的暫存記錄。');
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

// ---------- Gemini 呼叫（支援文字 + 檔案混合輸入） ----------
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
針對 search_keywords，請同時提供中文與英文兩種關鍵字（各1-2個）。
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

// ---------- 比對：PDF 直接以原生檔案格式交給 Gemini 讀取 ----------
async function compareClaimWithLiterature(claim, literatureFiles) {
  const parts = [
    {
      text: `你是一位資深醫學研究者，正坐在台下聽這場演講，準備在QA時間提問，也要幫聽眾（一位同領域的主治醫師）整理值得注意的重點。

演講論點：${claim.claim}
細節：${claim.detail}

以下附上使用者雲端硬碟中搜尋到的相關文獻全文檔案（依序編號為[文獻1]、[文獻2]...），請實際閱讀檔案內容（不是只看檔名），判斷是否支持、有疑慮、或可補充演講中的論點。

請依照以下三個部分輸出，每部分前面用【文獻查核】【值得提問】【特別亮點/疑慮】這三個標籤標示清楚：

【文獻查核】（3-4句）
- 根據實際讀到的文獻內容，是否支持、有疑慮、或可補充演講論點
- 明確標註根據哪一篇文獻（用[文獻N]標示），並簡述該文獻具體說了什麼（不要只講標題）
- 若附件文獻與論點無直接關聯，或無附件文獻，請如實說明「文庫中無直接對應文獻」，並改為根據你自己的醫學知識給出一般性評論

【值得提問】（1-2個具體問題）
- 站在同行專家角度，這個論點有什麼值得在QA時間追問講者的地方？
- 問題要具體、切中要害，例如數據的樣本數/追蹤時間是否足夠、是否有排除某些族群、跟現行指引是否有落差、講者有沒有利益衝突可能影響其立場等
- 若這個論點很明確沒有爭議，可以寫「此論點證據明確，暫無需特別追問」

【特別亮點/疑慮】（1-2句）
- 這個論點有沒有特別新穎、跟您原有認知不同、或可能改變臨床實務的地方？
- 或者反過來，有沒有講者可能誇大、簡化、或省略重要但別限制的地方？
- 若無特殊亮點或疑慮，可以寫「屬常規內容，無特別需標註之處」

只輸出上述三段內容，不要有其他文字。`,
    },
  ];

  if (literatureFiles.length === 0) {
    parts[0].text = parts[0].text.replace('以下附上使用者雲端硬碟中搜尋到的相關文獻全文檔案', '（本次未搜尋到相關文獻檔案）');
  } else {
    // 整批文獻總量控管：Gemini單次請求建議控制在約18MB內，優先讓大檔案（通常內容較完整的大型論文）能附上內文，
    // 超出預算時犧牲較小的檔案，改為僅附標題（避免因單篇超大檔案，拖累整批全部讀不到內容）
    const TOTAL_BUDGET = 18000000;
    const withSize = literatureFiles.map((f) => ({ ...f, _size: f.base64 ? f.base64.length : 0 }));
    const bySize = [...withSize].sort((a, b) => b._size - a._size);
    let runningTotal = 0;
    const allowSet = new Set();
    for (const f of bySize) {
      if (f._size === 0) continue; // 本來就沒抓到內容的，不佔預算
      if (runningTotal + f._size <= TOTAL_BUDGET) {
        runningTotal += f._size;
        allowSet.add(f.title);
      } else {
        log(`  ⚠️ 本次請求已達文獻總量上限，「${f.title}」改為僅供標題參考（未附全文）`);
      }
    }

    literatureFiles.forEach((f, i) => {
      parts.push({ text: `\n[文獻${i + 1}] 檔名：${f.title}` });
      if (f.base64 && f.mimeType && allowSet.has(f.title)) {
        parts.push({ inline_data: { mime_type: f.mimeType, data: f.base64 } });
      }
    });
  }

  return callGemini(parts);
}

// ---------- Google Drive 搜尋：抓檔案原始 bytes（含PDF），供 Gemini 原生讀取 ----------
async function searchLiterature(keywords, maxResults = 4) {
  if (!driveAccessToken) return [];
  const q = keywords.map((k) => `fullText contains '${k.replace(/'/g, "\\'")}'`).join(' or ');
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=files(id,name,mimeType)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
  if (!res.ok) return [];
  const data = await res.json();
  const files = data.files || [];
  log(`Drive搜尋到 ${files.length} 篇檔案：${files.map(f => f.name + '(' + (f.mimeType||'?') + ')').join('、') || '（無）'}`);

  const results = [];
  for (const file of files) {
    try {
      const isGoogleNative = file.mimeType && file.mimeType.startsWith('application/vnd.google-apps');
      // 不同 Google 原生類型要匯出成不同格式：試算表用 CSV，文件/簡報用純文字
      let exportMimeType = 'text/plain';
      if (file.mimeType === 'application/vnd.google-apps.spreadsheet') exportMimeType = 'text/csv';

      const fetchUrl = isGoogleNative
        ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMimeType)}`
        : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;

      const contentRes = await fetch(fetchUrl, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
      if (!contentRes.ok) {
        log(`  ✗ ${file.name}｜下載失敗，HTTP狀態碼：${contentRes.status}`);
        results.push({ title: file.name, mimeType: null, base64: null });
        continue;
      }

      const blob = await contentRes.blob();
      const base64 = await blobToBase64(blob);
      // 不管 Drive 回報的類型是什麼，只要副檔名是 .pdf 就強制當作 application/pdf
      // 因為手機上傳時 Drive 有時會把 PDF 誤判為 application/octet-stream，導致 Gemini 無法正確解析
      let mimeType;
      if (isGoogleNative) {
        mimeType = exportMimeType;
      } else if (/\.pdf$/i.test(file.name)) {
        mimeType = 'application/pdf';

      } else {
        mimeType = file.mimeType || 'application/octet-stream';
      }

      // 單檔上限抓在 Gemini inline data 上限附近（約 20MB 原始檔案，base64後略膨脹）
      // 真正決定「這篇要不要真的讀內文」的總量控管，留給 compareClaimWithLiterature 依整批大小動態決定
      if (base64.length > 27000000) {
        log(`  ⚠️ ${file.name} 檔案過大（${(base64.length/1000000).toFixed(1)}MB，超過Gemini單檔上限），僅供標題參考`);
        results.push({ title: file.name, mimeType: null, base64: null });
      } else {
        log(`  ✓ ${file.name}｜類型：${mimeType}｜大小：${(base64.length/1000).toFixed(0)}KB`);
        results.push({ title: file.name, mimeType, base64 });
      }
    } catch (e) {
      log(`  ✗ ${file.name}｜讀取失敗：${e.message}`);
      results.push({ title: file.name, mimeType: null, base64: null });
    }
  }
  return results;
}

// ---------- 佇列系統 ----------
const jobQueue = [];
let isProcessing = false;

function queueAnalysis(blob, label) {
  jobCounter++;
  const jobId = jobCounter;
  const card = createReportCard(jobId, label);
  reportsEl.prepend(card);
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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 把逐字稿（預設摺疊，不佔版面）+ 分析結果，一起塞進卡片的 body
function setCardBodyWithTranscript(jobId, transcript, analysisText) {
  const card = document.getElementById(`report-${jobId}`);
  if (!card) return;
  const body = card.querySelector('.report-body');
  const transcriptHtml = transcript
    ? `<details style="margin-bottom:10px;"><summary style="cursor:pointer;color:#2b5797;">📝 查看逐字稿（點擊展開，共${transcript.length}字，供核對用）</summary><div style="white-space:pre-wrap;font-size:12.5px;color:#555;margin-top:8px;max-height:300px;overflow-y:auto;border:1px solid #eee;border-radius:6px;padding:8px;">${escapeHtml(transcript)}</div></details>`
    : '';
  body.innerHTML = transcriptHtml + `<div style="white-space:pre-wrap;">${escapeHtml(analysisText)}</div>`;
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
  let transcript = '';
  try {
    updateCard(jobId, `🔄 ${label}｜正在轉錄音訊...`);
    transcript = await transcribeAudio(blob);
    log(`📝 ${label}｜轉錄預覽（前80字）：${transcript.slice(0, 80)}...`);

    updateCard(jobId, `🔄 ${label}｜正在萃取核心論點...`);
    const claims = await extractClaims(transcript);

    let md = '';
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      updateCard(jobId, `🔄 ${label}｜搜尋第 ${i + 1}/${claims.length} 個論點的文獻`);
      const literature = await searchLiterature(claim.search_keywords || [claim.claim]);
      const literatureNames = literature.map((l) => `${l.title}${l.base64 ? '(已附檔案)' : '(僅標題,未附檔案)'}`).join('、');

      updateCard(jobId, `🔄 ${label}｜Gemini 正在閱讀文獻並比對第 ${i + 1}/${claims.length} 個論點`);

      let comment;
      try {
        comment = await compareClaimWithLiterature(claim, literature);
      } catch (claimErr) {
        log(`❌ 第${i + 1}個論點失敗｜論點：${claim.claim}`);
        log(`   送出的文獻：${literatureNames || '（無）'}`);
        log(`   錯誤訊息：${claimErr.message}`);
        comment = `（此論點分析失敗，已跳過，詳見上方狀態區的錯誤紀錄。錯誤訊息：${claimErr.message}）`;
      }

      md += `【${i + 1}】${claim.claim}\n細節：${claim.detail}\n意見：${comment}\n`;
      if (literature.length) md += `參考文獻：${literatureNames}\n`;
      md += '\n';
    }

    updateCard(jobId, `✅ ${label}｜完成`);
    setCardBodyWithTranscript(jobId, transcript, md);
  } catch (err) {
    log(`❌ ${label} 整場分析失敗｜錯誤訊息：${err.message}`);
    updateCard(jobId, `❌ ${label}｜錯誤：${err.message}`);
    if (transcript) setCardBodyWithTranscript(jobId, transcript, '（此場後續分析失敗，但轉錄已完成，可展開下方逐字稿查看）');
  }
}
