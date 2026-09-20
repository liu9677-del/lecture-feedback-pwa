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
  const jobId = jobCounter;
  const card = createReportCard(jobId, label);
  reportsEl.prepend(card);
  updateCard(jobId, `⏳ ${label}｜正在上傳音檔到背景伺服器...`);

  try {
    const base64 = await blobToBase64(blob);
    log(`📤 ${label}｜開始上傳（音檔大小約 ${(base64.length / 1000).toFixed(0)}KB）`);

    updateCard(jobId, `🔄 ${label}｜已上傳，伺服器正在背景處理中（此時您可以離開此頁面，處理完成後報告會存到您的 Google Drive「演講評論報告」資料夾）`);

    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ audioBase64: base64, mimeType, label }),
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '未知錯誤');

    log(`✅ ${label}｜背景處理完成！`);
    updateCard(jobId, `✅ ${label}｜完成`, `報告已存到您的 Google Drive「演講評論報告」資料夾。\n\n點此開啟：${data.docUrl}`);

    const card2 = document.getElementById(`report-${jobId}`);
    if (card2) {
      const body = card2.querySelector('.report-body');
      const link = document.createElement('a');
      link.href = data.docUrl;
      link.target = '_blank';
      link.textContent = '📄 開啟報告文件';
      link.style.cssText = 'display:inline-block;margin-top:8px;color:#2b5797;font-weight:600;';
      body.appendChild(link);
    }
  } catch (err) {
    log(`❌ ${label}｜錯誤：${err.message}`);
    updateCard(jobId, `❌ ${label}｜錯誤：${err.message}`);
  }
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
