// ===== 設定區 =====
const CONFIG = {
  // 貼上您在 Apps Script 部署後拿到的網址（結尾是 /exec）
  APPS_SCRIPT_URL: 'https://script.google.com/a/macros/tmu.edu.tw/s/AKfycbwzizHO3u1VLFU35sAqMLMDgYhv-KpBTTSU7uRteXzJrqU2k7WK980cxlz_MVXMyWN2/exec',
};
// ===================================

let mediaRecorder;
let audioChunks = [];
let jobCounter = 0;

const statusEl = document.getElementById('status');
const reportsEl = document.getElementById('reports');
const recordBtn = document.getElementById('recordBtn');
const clearBtn = document.getElementById('clearBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');

function log(msg) {
  statusEl.textContent += msg + '\n';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- 錄音：錄完立刻上傳到 Apps Script，不用等分析、可以馬上離開頁面 ----------
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
    submitToBackground(blob, 'audio/webm', `錄音 ${new Date().toLocaleTimeString('zh-TW')}`);
  };
  mediaRecorder.start();
  recordBtn.textContent = '停止錄音（上傳後可離開頁面）';
  recordBtn.classList.add('recording');
  log('錄音中...');
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    submitToBackground(file, file.type || 'audio/webm', file.name);
    fileInput.value = '';
  }
});

// ---------- 清除全部暫存記錄 ----------
clearBtn.addEventListener('click', () => {
  if (!confirm('確定要清除目前畫面上所有的紀錄嗎？（不影響已經上傳到 Google Drive 的報告，只是清空這個畫面）')) return;
  reportsEl.innerHTML = '';
  statusEl.textContent = '';
  log('已清除畫面上的暫存記錄。');
});

// ---------- 上傳到 Apps Script，背景處理，不阻塞介面 ----------
async function submitToBackground(blob, mimeType, label) {
  jobCounter++;
  const cardKey = jobCounter;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const card = createReportCard(cardKey, label);
  reportsEl.prepend(card);
  updateCard(cardKey, `⏳ ${label}｜正在上傳音檔到背景伺服器...`);

  try {
    const base64 = await blobToBase64(blob);
    log(`📤 ${label}｜開始上傳（音檔大小約 ${(base64.length / 1000).toFixed(0)}KB）`);

    // 用 no-cors 模式「送出」：這個方向的請求本來就穩定，只是讀不到回應，改用no-cors不理會回應即可。
    await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({ audioBase64: base64, mimeType, label, jobId }),
    });

    updateCard(cardKey, `🔄 ${label}｜已送出，伺服器背景處理中，正在查詢進度...`);
    log(`📤 ${label}｜已送出，開始查詢處理進度（可安心離開此頁面，回來時進度會遺失但伺服器仍會繼續處理，請直接看Drive）`);
    pollJobStatus(jobId, cardKey, label, 0);
  } catch (err) {
    log(`❌ ${label}｜上傳失敗：${err.message}`);
    updateCard(cardKey, `❌ ${label}｜上傳失敗：${err.message}`);
  }
}

// ---------- JSONP 輪詢：用 <script> 標籤查詢進度，完全不受 CORS 限制影響 ----------
function pollJobStatus(jobId, cardKey, label, attempt) {
  const MAX_ATTEMPTS = 60; // 每8秒查一次，最多查約8分鐘
  if (attempt >= MAX_ATTEMPTS) {
    updateCard(cardKey, `⚠️ ${label}｜查詢逾時`, `伺服器可能仍在處理，或查詢遇到問題。請直接至 Google Drive「演講評論報告」資料夾查看是否已產生報告。`);
    return;
  }

  const callbackName = `jobCb_${jobId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const script = document.createElement('script');

  const cleanup = () => {
    delete window[callbackName];
    if (script.parentNode) script.parentNode.removeChild(script);
  };

  window[callbackName] = (data) => {
    cleanup();
    if (data.status === 'done') {
      log(`✅ ${label}｜背景處理完成！`);
      updateCard(cardKey, `✅ ${label}｜完成`, `報告已存到您的 Google Drive「演講評論報告」資料夾。`);
      const cardEl = document.getElementById(`report-${cardKey}`);
      if (cardEl) {
        const body = cardEl.querySelector('.report-body');
        const link = document.createElement('a');
        link.href = data.docUrl;
        link.target = '_blank';
        link.textContent = '📄 開啟報告文件';
        link.style.cssText = 'display:inline-block;margin-top:8px;color:#2b5797;font-weight:600;';
        body.appendChild(link);
      }
    } else if (data.status === 'error') {
      log(`❌ ${label}｜背景處理失敗：${data.message}`);
      updateCard(cardKey, `❌ ${label}｜處理失敗`, data.message || '未知錯誤');
    } else {
      // pending 或 processing，繼續等待後再查一次
      updateCard(cardKey, `🔄 ${label}｜伺服器處理中...（已查詢 ${attempt + 1} 次）`);
      setTimeout(() => pollJobStatus(jobId, cardKey, label, attempt + 1), 8000);
    }
  };

  script.onerror = () => {
    cleanup();
    // 查詢本身失敗（少見），稍後重試，不影響伺服器端實際處理
    setTimeout(() => pollJobStatus(jobId, cardKey, label, attempt + 1), 8000);
  };

  script.src = `${CONFIG.APPS_SCRIPT_URL}?jobId=${encodeURIComponent(jobId)}&callback=${callbackName}`;
  document.body.appendChild(script);
}

function createReportCard(jobId, label) {
  const card = document.createElement('div');
  card.id = `report-${jobId}`;
  card.className = 'report-card';
  card.innerHTML = `<div class="report-header">⏳ ${label}｜準備中...</div><div class="report-body"></div>`;
  return card;
}

function updateCard(jobId, headerText, bodyText) {
  const card = document.getElementById(`report-${jobId}`);
  if (!card) return;
  card.querySelector('.report-header').textContent = headerText;
  if (bodyText !== undefined) card.querySelector('.report-body').textContent = bodyText;
}
