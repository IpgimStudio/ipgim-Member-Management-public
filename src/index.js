import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import fetch from 'node-fetch';

// ─────────────────── 환경설정 ───────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, './config.json');
let CONFIG = {};

if (fs.existsSync(CONFIG_FILE)) {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  console.log('[CONFIG] 파일 로드 완료');
}

// 환경변수 세팅 (GitHub Actions)
CONFIG.slack = CONFIG.slack || {};
CONFIG.sheets = CONFIG.sheets || {};
if (process.env.SLACK_BOT_TOKEN) CONFIG.slack.token = process.env.SLACK_BOT_TOKEN;
if (process.env.SLACK_CHANNEL_ID) CONFIG.slack.channelId = process.env.SLACK_CHANNEL_ID;
if (process.env.SHEET_ID) CONFIG.sheets.sheetId = process.env.SHEET_ID;
if (process.env.GOOGLE_SERVICE_EMAIL) CONFIG.sheets.serviceEmail = process.env.GOOGLE_SERVICE_EMAIL;
if (process.env.GOOGLE_PRIVATE_KEY) CONFIG.sheets.privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

if (!CONFIG.sheets.sheetNames) {
  CONFIG.sheets.sheetNames = { attendance: '출퇴근기록' };
}

// ─────────────────── 유틸리티 ───────────────────
function formatTimeDisplay(ts) {
  const kst = new Date(parseFloat(ts) * 1000 + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const ampm = hour < 12 ? '오전' : '오후';
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${ampm} ${h12}:${String(minute).padStart(2, '0')}`;
}

function getDateFromTs(ts) {
  const kst = new Date(parseFloat(ts) * 1000 + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// ─────────────────── Slack 클라이언트 ───────────────────
class SlackClient {
  constructor(token) { this.token = token; }

  async call(method, params = {}) {
    const body = new URLSearchParams(params);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API 오류 [${method}]: ${data.error}`);
    return data;
  }

  async fetchMessagesInRange(channelId, oldest) {
    const allMessages = [];
    let cursor;
    do {
      const params = { channel: channelId, limit: 200 };
      if (oldest) params.oldest = oldest;
      if (cursor) params.cursor = cursor;
      
      const result = await this.call('conversations.history', params);
      allMessages.push(...result.messages);
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
    
    // 과거(오래된) 메시지부터 순서대로 처리하기 위해 오름차순 정렬
    return allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  async getChannelInfo(channelId) {
    return this.call('conversations.info', { channel: channelId });
  }
}

// ─────────────────── Sheets 클라이언트 ───────────────────
class SheetsClient {
  constructor() {
    const auth = new google.auth.JWT(
      CONFIG.sheets.serviceEmail,
      null,
      CONFIG.sheets.privateKey,
      ['https://www.googleapis.com/auth/spreadsheets'],
    );
    this.sheets = google.sheets({ version: 'v4', auth });
    this.sheetId = CONFIG.sheets.sheetId;
  }

  async ensureSheet(sheetName, headerRow) {
    const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    const exists = res.data.sheets.some(s => s.properties.title === sheetName);
    if (exists) return;

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
    console.log(`[Sheets] 시트 생성: ${sheetName}`);
  }

  async readAll(sheetName) {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `'${sheetName}'!A:K`,
    });
    return res.data.values || [];
  }

  getLatestSlackTs(rows) {
    if (!rows || rows.length < 2) return null;
    let latest = 0;
    for (let i = 1; i < rows.length; i++) {
      const ts = parseFloat(rows[i][9]); // J열 = slack_ts
      if (ts > latest) latest = ts;
    }
    return latest === 0 ? null : String(latest);
  }
}

// ─────────────────── 메시지 파싱 ───────────────────
function parseAttendanceMessage(msg, today) {
  const text = msg.text?.trim() || '';
  const patterns = [
    /^(.+?)\s+(출근|퇴근|퇴군)\s*$/,
    /^(.+?)\s+(출근|퇴근|퇴군)\s+(.+)$/,
    /^(.+?)\s+(출근|퇴근|퇴군)\s*[(\/]\s*(.+?)\s*[)]?$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const result = {
        slackTs: msg.ts,
        timestamp: parseFloat(msg.ts),
        date: today,
        name: match[1].trim(),
        type: match[2] === '출근' ? 'check-in' : 'check-out',
        workType: '고정',
        status: '정상',
        note: '',
      };
      
      if (match[3]) {
        const rest = match[3].trim();
        if (rest.includes('유연')) result.workType = '유연';
        
        const statusMap = { 지각: '지각', 시간외: '시간외', 조퇴: '조퇴', 결근: '결근' };
        for (const [k, v] of Object.entries(statusMap)) {
          if (rest.includes(k)) { result.status = v; break; }
        }
        
        const noteMatch = rest.match(/[\(（](.+?)[\)）]/);
        if (noteMatch) result.note = noteMatch[1];
      }
      return result;
    }
  }
  return null;
}

// ─────────────────── 메인 로직 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 로거 v2.0 실행');
  console.log('========================================\n');

  const sheets = new SheetsClient();
  const sheetName = CONFIG.sheets.sheetNames.attendance;
  const headerRow = ['날짜', '이름', '출근시간', '퇴근시간', '근무유형', '상태', '연장', '연장시간(분)', '비고', 'slack_ts', '출처'];

  await sheets.ensureSheet(sheetName, headerRow);
  
  // 1. 기존 데이터 읽기 및 마지막 수집 시점 파악
  let existingRows = await sheets.readAll(sheetName);
  const lastTs = sheets.getLatestSlackTs(existingRows);
  console.log(`[Sheets] 기존 데이터: ${Math.max(0, existingRows.length - 1)}행`);
  console.log(`[Sheets] 마지막 수집 Timestamp: ${lastTs ?? '없음 (최초 전체 수집 시작)'}\n`);

  // 2. Slack 채널 정보 및 메시지 조회
  const slack = new SlackClient(CONFIG.slack.token);
  const oldest = lastTs ? String(parseFloat(lastTs) + 0.000001) : '0'; // 마지막 수집 직후부터
  
  console.log(`--- Slack 채널 메시지 수집 중... ---`);
  const messages = await slack.fetchMessagesInRange(CONFIG.slack.channelId, oldest);
  console.log(`[Slack] 처리할 새 메시지: ${messages.length}건\n`);

  if (messages.length === 0) {
    console.log(`✅ 새로운 출퇴근 기록이 없습니다. 로직을 종료합니다.`);
    return;
  }

  // 3. 메시지 분석 및 시트 반영 준비
  const toAppend = [];
  const toUpdate = []; // { range, values }
  let parsedCount = 0;

  for (const msg of messages) {
    if (msg.subtype) continue; // 봇 메시지 등 제외
    
    const dateStr = getDateFromTs(msg.ts);
    const parsed = parseAttendanceMessage(msg, dateStr);
    
    if (!parsed || !parsed.name) continue;
    parsedCount++;

    const timeStr = formatTimeDisplay(parsed.timestamp);
    const typeStr = parsed.type === 'check-in' ? '▶ 출근' : '◀ 퇴근';
    console.log(`  ${parsed.date} ${parsed.name.padEnd(6)} ${typeStr} ${timeStr.padEnd(8)} [${parsed.status}] ${parsed.note}`);

    if (parsed.type === 'check-in') {
      // 출근 기록은 무조건 새 행으로 추가
      toAppend.push([
        parsed.date, parsed.name, timeStr, '', parsed.workType, parsed.status, '', '', parsed.note, parsed.slackTs, 'slack-logger'
      ]);
      // 새로 추가될 데이터도 existingRows 구조에 임시 반영 (당일 퇴근 처리 시 찾기 위함)
      existingRows.push([parsed.date, parsed.name, timeStr, '', parsed.workType, parsed.status, '', '', parsed.note, parsed.slackTs, 'slack-logger']);
    } 
    else if (parsed.type === 'check-out') {
      // 퇴근 기록: 당일 동일 이름의 행을 아래에서부터 탐색
      let targetRowIdx = -1;
      for (let i = existingRows.length - 1; i >= 1; i--) {
        const row = existingRows[i];
        if (row[0] === parsed.date && row[1] === parsed.name) {
          targetRowIdx = i;
          break;
        }
      }

      if (targetRowIdx !== -1) {
        // 기존 행이 존재하는 경우 (출근 기록이 있음): D열(퇴근시간)과 J열(slack_ts 최신화)만 업데이트
        existingRows[targetRowIdx][3] = timeStr; // D열 메모리 업데이트
        existingRows[targetRowIdx][9] = parsed.slackTs; // J열 메모리 업데이트 (마지막 수집 시점 갱신용)
        
        toUpdate.push({
          range: `'${sheetName}'!D${targetRowIdx + 1}`,
          values: [[timeStr]]
        });
        toUpdate.push({
          range: `'${sheetName}'!J${targetRowIdx + 1}`,
          values: [[parsed.slackTs]]
        });
      } else {
        // 출근 기록 없이 퇴근 메시지만 있는 경우: 새 행으로 추가 (출근시간 비움)
        toAppend.push([
          parsed.date, parsed.name, '', timeStr, parsed.workType, parsed.status, '', '', parsed.note, parsed.slackTs, 'slack-logger'
        ]);
        existingRows.push([parsed.date, parsed.name, '', timeStr, parsed.workType, parsed.status, '', '', parsed.note, parsed.slackTs, 'slack-logger']);
      }
    }
  }

  // 4. Google Sheets 일괄 쓰기 (Batching)
  if (toAppend.length > 0) {
    await sheets.sheets.spreadsheets.values.append({
      spreadsheetId: sheets.sheetId,
      range: `'${sheetName}'!A:K`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend },
    });
    console.log(`\n[Sheets] ${toAppend.length}개의 새로운 출/퇴근 행 추가 완료`);
  }

  if (toUpdate.length > 0) {
    await sheets.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheets.sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: toUpdate
      }
    });
    console.log(`[Sheets] ${toUpdate.length / 2}건의 퇴근 시간 업데이트 완료`);
  }

  console.log(`\n========================================`);
  console.log(`  ✅ 수집 완료 (유효 데이터: ${parsedCount}건)`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('\n❌ 실행 중 오류 발생:', err);
  process.exit(1);
});