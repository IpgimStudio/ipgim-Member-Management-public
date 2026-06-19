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
}

CONFIG.slack = CONFIG.slack || {};
CONFIG.sheets = CONFIG.sheets || {};
if (process.env.SLACK_BOT_TOKEN) CONFIG.slack.token = process.env.SLACK_BOT_TOKEN;
if (process.env.SLACK_CHANNEL_ID) CONFIG.slack.channelId = process.env.SLACK_CHANNEL_ID;
if (process.env.SHEET_ID) CONFIG.sheets.sheetId = process.env.SHEET_ID;
if (process.env.GOOGLE_SERVICE_EMAIL) CONFIG.sheets.serviceEmail = process.env.GOOGLE_SERVICE_EMAIL;
if (process.env.GOOGLE_PRIVATE_KEY) CONFIG.sheets.privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

if (!CONFIG.sheets.sheetNames) CONFIG.sheets.sheetNames = { attendance: '출퇴근기록' };

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
    
    // 과거 메시지부터 순서대로 정렬
    return allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  async getUsers() {
    const userMap = {};
    let cursor;
    do {
      const params = { limit: 200 };
      if (cursor) params.cursor = cursor;
      const res = await this.call('users.list', params);
      for (const member of res.members) {
        userMap[member.id] = member.profile?.display_name || member.real_name || member.name;
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    return userMap;
  }
}

// ─────────────────── Sheets 클라이언트 ───────────────────
class SheetsClient {
  constructor() {
    const auth = new google.auth.JWT(
      CONFIG.sheets.serviceEmail, null, CONFIG.sheets.privateKey,
      ['https://www.googleapis.com/auth/spreadsheets'],
    );
    this.sheets = google.sheets({ version: 'v4', auth });
    this.sheetId = CONFIG.sheets.sheetId;
  }

  async ensureSheet(sheetName, headerRow) {
    const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    if (res.data.sheets.some(s => s.properties.title === sheetName)) return;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId, range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW', requestBody: { values: [headerRow] },
    });
  }

  async readAll(sheetName) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `'${sheetName}'!A:K` });
    return res.data.values || [];
  }

  getLatestSlackTs(rows) {
    if (!rows || rows.length < 2) return null;
    let latest = 0;
    for (let i = 1; i < rows.length; i++) {
      const ts = parseFloat(rows[i][9]);
      if (ts > latest) latest = ts;
    }
    return latest === 0 ? null : String(latest);
  }
}

// ─────────────────── 메인 로직 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 로거 v4.0 실행 (모든 메시지 수집)');
  console.log('========================================\n');

  const sheets = new SheetsClient();
  const sheetName = CONFIG.sheets.sheetNames.attendance;
  // 기존 헤더 구조 유지
  const headerRow = ['날짜', '이름', '출근시간', '퇴근시간', '근무유형', '상태', '연장', '연장시간(분)', '비고', 'slack_ts', '출처'];

  await sheets.ensureSheet(sheetName, headerRow);
  
  let existingRows = await sheets.readAll(sheetName);
  const lastTs = sheets.getLatestSlackTs(existingRows);
  console.log(`[Sheets] 기준 데이터: ${Math.max(0, existingRows.length - 1)}행 (마지막 TS: ${lastTs ?? '없음'})`);

  const slack = new SlackClient(CONFIG.slack.token);
  
  console.log(`\n--- Slack 사용자 목록 동기화 중 ---`);
  const userMap = await slack.getUsers();
  console.log(`[Slack] ${Object.keys(userMap).length}명의 사용자 이름 로드 완료!`);

  const oldest = lastTs ? String(parseFloat(lastTs) + 0.000001) : '0';
  
  console.log(`\n--- Slack 채널 메시지 수집 중... ---`);
  const messages = await slack.fetchMessagesInRange(CONFIG.slack.channelId, oldest);
  console.log(`[Slack] 처리할 새 메시지: ${messages.length}건\n`);

  if (messages.length === 0) return console.log(`✅ 새로운 메시지가 없습니다.`);

  const toAppend = [];
  let parsedCount = 0;

  for (const msg of messages) {
    // 사용자가 남긴 일반 메시지만 처리 (시스템 메시지/봇 메시지는 대부분 걸러짐)
    if (msg.subtype && msg.subtype !== 'message_changed') continue; 
    
    const text = msg.text?.trim() || '';
    if (!text && !msg.attachments && !msg.files) continue; // 완전히 빈 메시지 제외

    parsedCount++;
    const dateStr = getDateFromTs(msg.ts);
    const timeStr = formatTimeDisplay(msg.ts);
    const userName = userMap[msg.user] || msg.user || '알 수 없음';
    
    // 줄바꿈 문자를 공백으로 변경하여 한 줄로 만들기
    const noteText = text.replace(/\n/g, ' ');

    console.log(`  [${dateStr} ${timeStr}] ${userName.padEnd(6)}: ${noteText.substring(0, 20)}...`);

    // 모든 메시지를 단순히 새 행으로 추가
    toAppend.push([
      dateStr,      // A: 날짜
      userName,     // B: 이름
      timeStr,      // C: 출근시간 (작성 시간으로 활용)
      '',           // D: 퇴근시간 (비워둠)
      '',           // E: 근무유형
      '',           // F: 상태
      '',           // G: 연장
      '',           // H: 연장시간(분)
      noteText,     // I: 비고 (메시지 전체 내용)
      msg.ts,       // J: slack_ts (중복 검사 및 마지막 수집 위치 파악용)
      'slack-logger'// K: 출처
    ]);
  }

  if (toAppend.length > 0) {
    await sheets.sheets.spreadsheets.values.append({
      spreadsheetId: sheets.sheetId, 
      range: `'${sheetName}'!A:K`,
      valueInputOption: 'USER_ENTERED', 
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend },
    });
  }

  console.log(`\n========================================`);
  console.log(`  ✅ 수집 완료 (정상 반영: ${parsedCount}건)`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('\n❌ 실행 중 오류 발생:', err);
  process.exit(1);
});