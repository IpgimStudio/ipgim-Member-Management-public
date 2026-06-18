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

// 환경변수 우선 (GitHub Actions)
if (process.env.SLACK_BOT_TOKEN) CONFIG.slack = CONFIG.slack || {};
if (process.env.SLACK_BOT_TOKEN) CONFIG.slack.token = process.env.SLACK_BOT_TOKEN;
if (process.env.SLACK_CHANNEL_ID) CONFIG.slack = CONFIG.slack || {};
if (process.env.SLACK_CHANNEL_ID) CONFIG.slack.channelId = process.env.SLACK_CHANNEL_ID;
if (process.env.SHEET_ID) CONFIG.sheets = CONFIG.sheets || {};
if (process.env.SHEET_ID) CONFIG.sheets.sheetId = process.env.SHEET_ID;
if (process.env.GOOGLE_SERVICE_EMAIL) CONFIG.sheets = CONFIG.sheets || {};
if (process.env.GOOGLE_SERVICE_EMAIL) CONFIG.sheets.serviceEmail = process.env.GOOGLE_SERVICE_EMAIL;
if (process.env.GOOGLE_PRIVATE_KEY) {
  CONFIG.sheets = CONFIG.sheets || {};
  CONFIG.sheets.privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

// 시트 이름
if (!CONFIG.sheets) CONFIG.sheets = {};
if (!CONFIG.sheets.sheetNames) {
  CONFIG.sheets.sheetNames = {
    attendance: '출퇴근기록',
  };
}

// ─────────────────── 타임 포맷 ───────────────────
function parseTimeString(str) {
  if (!str) return null;
  const [hour, min] = str.split(':').map(Number);
  return { hour, minute: min };
}

function formatTimeDisplay(ts) {
  const d = new Date(ts * 1000);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const ampm = hour < 12 ? '오전' : '오후';
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${ampm} ${h12}:${String(minute).padStart(2, '0')}`;
}

// ─────────────────── Slack ───────────────────
class SlackClient {
  constructor(token) {
    this.token = token;
  }

  async call(method, params = {}) {
    const url = `https://slack.com/api/${method}`;
    const body = new URLSearchParams(params);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Slack API 오류 [${method}]: ${data.error}`);
    }
    return data;
  }

  /**
   * 특정 채널의 메시지 이력을 oldest ts 기준으로 조회 (페이지네이션, 최대 1000개)
   * API Research: conversations.history (Tier 3, 50+ req/min, max 1000/page)
   */
  async fetchMessagesSince(channelId, oldestTs) {
    const allMessages = [];
    let cursor;

    do {
      const params = {
        channel: channelId,
        oldest: oldestTs,
        limit: 200,
      };
      if (cursor) params.cursor = cursor;

      const result = await this.call('conversations.history', params);
      allMessages.push(...result.messages);

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    console.log(`[Slack] 총 ${allMessages.length}개 메시지 수신 (oldest=${oldestTs})`);
    return allMessages;
  }

  /**
   * 각종 메타 조회 (채널명 확인 / 사용자 정보)
   */
  async getChannelInfo(channelId) {
    return this.call('conversations.info', { channel: channelId });
  }
}

// ─────────────────── Google Sheets ───────────────────
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

  /**
   * 시트가 없으면 생성
   */
  async ensureSheet(sheetName, headerRow) {
    try {
      const res = await this.sheets.spreadsheets.get({
        spreadsheetId: this.sheetId,
      });
      const exists = res.data.sheets.some(s => s.properties.title === sheetName);
      if (exists) return;

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });
      // 헤더写入
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: `'${sheetName}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headerRow] },
      });
      console.log(`[Sheets] 시트 생성: ${sheetName}`);
    } catch (err) {
      console.error(`[Sheets] ensureSheet 오류:`, err.message);
    }
  }

  /**
   * 시트에서 가장 최근 slack_ts(소수점 Unix timestamp) 찾기
   * 없으면 null 반환 (최초 실행 시)
   */
  getLatestSlackTs(rows) {
    if (!rows || rows.length < 2) return null; // 헤더만 있거나 빈 시트
    let latest = null;
    for (let i = 1; i < rows.length; i++) {
      const tsStr = rows[i][9]; // J열 = slack_ts
      if (!tsStr) continue;
      const ts = parseFloat(tsStr);
      if (latest === null || ts > latest) latest = ts;
    }
    return latest;
  }

  /**
   * 모든 데이터를 한 번에 읽기
   */
  async readAll(sheetName) {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `'${sheetName}'!A:K`,
      });
      return res.data.values || [];
    } catch {
      return [];
    }
  }

  /**
   * 새 레코드들을 시트에 추가 (중복 검사 수행)
   */
  async appendRecords(sheetName, newRows, existingRows) {
    if (newRows.length === 0) {
      console.log(`[Sheets] 추가할 새 데이터 없음`);
      return;
    }

    // 중복 검사: 기존 데이터의 slack_ts(column J)와 비교
    const existingTsSet = new Set();
    if (existingRows && existingRows.length > 1) {
      for (let i = 1; i < existingRows.length; i++) {
        const ts = existingRows[i][9]; // J열 = slack_ts
        if (ts) existingTsSet.add(ts);
      }
    }

    const toAppend = newRows.filter(r => !existingTsSet.has(r.slackTs));
    if (toAppend.length === 0) {
      console.log(`[Sheets] 중복 제거 후 추가할 데이터 없음`);
      return;
    }

    // A:날짜 B:이름 C:출근 D:퇴근 E:근무유형 F:상태 G:연장 H:연장시간(분) I:비고 J:slack_ts K:출처
    const values = toAppend.map(r => [
      r.date,               // A: 날짜
      r.name,               // B: 이름
      r.type === 'check-in' ? formatTimeDisplay(r.timestamp) : '',  // C: 출근시간
      r.type === 'check-out' ? formatTimeDisplay(r.timestamp) : '', // D: 퇴근시간
      r.workType === 'flexible' ? '유연' : '고정',                  // E: 근무유형
      r.status,             // F: 상태
      '',                   // G: 연장 (서버 sheets-db에서 관리)
      '',                   // H: 연장시간(분) (서버 sheets-db에서 관리)
      r.note || '',         // I: 비고
      r.slackTs,            // J: Slack TS (중복방지용)
      'slack-logger',       // K: 출처
    ]);

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `'${sheetName}'!A:K`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    console.log(`[Sheets] ${toAppend.length}개 레코드 추가 완료`);
  }
}

// ─────────────────── 파싱 ───────────────────
function parseAttendanceMessage(msg, today) {
  const result = {
    slackTs: msg.ts,
    user: msg.user,
    text: msg.text || '',
    timestamp: parseFloat(msg.ts),
    date: today,
    type: null,
    name: '',
    workType: 'fixed',
    status: '정상',
    note: '',
  };

  const text = msg.text?.trim() || '';

  const patterns = [
    // "이름 출근" or "이름 퇴근"
    /^(.+?)\s+(출근|퇴근|퇴군)\s*$/,
    /^(.+?)\s+(출근|퇴근|퇴군)\s+(.+)$/,
    // "이름 출근/퇴근"
    /^(.+?)\s+(출근|퇴근|퇴군)\s*[(\/]\s*(.+?)\s*[)]?$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      result.name = match[1].trim();
      const typeRaw = match[2];
      result.type = typeRaw === '출근' ? 'check-in' : 'check-out';
      if (match[3]) {
        const rest = match[3].trim();
        // 근무유형: 유연/고정
        if (rest.includes('유연')) result.workType = 'flexible';
        // 상태: 지각/시간외/조퇴/결근
        const statusMap = { 지각: '지각', 시간외: '시간외', 조퇴: '조퇴', 결근: '결근' };
        for (const [k, v] of Object.entries(statusMap)) {
          if (rest.includes(k)) { result.status = v; break; }
        }
        // 비고: 괄호 안 내용
        const noteMatch = rest.match(/[\(（](.+?)[\)）]/);
        if (noteMatch) result.note = noteMatch[1];
      }
      return result;
    }
  }

  return null;
}

// ─────────────────── 메인 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 로거 v1.0 실행');
  console.log('========================================\n');

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  console.log(`[TIME] 실행: ${now.toISOString()}`);

  // 1. 시트에서 마지막 수집 지점 확인
  console.log(`\n--- 마지막 수집 지점 확인 ---`);
  const sheets = new SheetsClient();

  const headerRow = ['날짜', '이름', '출근시간', '퇴근시간', '근무유형', '상태', '연장', '연장시간(분)', '비고', 'slack_ts', '출처'];
  const sheetName = CONFIG.sheets.sheetNames.attendance;

  await sheets.ensureSheet(sheetName, headerRow);

  const existingRows = await sheets.readAll(sheetName);
  const lastTs = sheets.getLatestSlackTs(existingRows);
  console.log(`[Sheets] 기존 데이터 ${existingRows.length > 0 ? existingRows.length - 1 : 0}행`);
  console.log(`[Sheets] 마지막 slack_ts: ${lastTs ?? '없음 (최초 수집)'}`);

  // 2. Slack 메시지 수집 — 마지막 수집 시점 이후부터
  const slack = new SlackClient(CONFIG.slack.token);
  console.log(`\n--- Slack 채널 메시지 수집 ---`);

  const channelInfo = await slack.getChannelInfo(CONFIG.slack.channelId);
  console.log(`[Slack] 채널: ${channelInfo.channel.name} (ID: ${CONFIG.slack.channelId})`);

  // oldestTs: 마지막 수집 시점이 있으면 그 시점부터, 없으면 전체 (에포크 이후)
  const oldestTs = lastTs ?? '0';
  const messages = await slack.fetchMessagesSince(CONFIG.slack.channelId, oldestTs);

  if (messages.length === 0) {
    console.log('[INFO] 수집된 메시지 없음. 종료합니다.');
    return;
  }

  // slack_ts 기준 오름차순 정렬
  messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  // 3. 파싱
  console.log(`\n--- 출퇴근 메시지 파싱 ---`);
  const records = [];

  for (const msg of messages) {
    const parsed = parseAttendanceMessage(msg, today);
    if (!parsed) continue;

    // 봇/서브타입 메시지 제외
    if (msg.subtype && msg.subtype !== 'bot_message') continue;
    if (parsed.name.length < 1) continue;

    records.push(parsed);

    // 상태 추론 (note에 지각/조퇴 등이 포함된 경우)
    parsed.status = parsed.status || '정상';
    parsed.note = parsed.note || '';

    const timeStr = formatTimeDisplay(parsed.timestamp);
    const typeStr = parsed.type === 'check-in' ? '▶ 출근' : '◀ 퇴근';
    console.log(`  ${parsed.name.padEnd(8)} ${typeStr} ${timeStr.padEnd(12)} [${parsed.status}]${parsed.note ? ` (${parsed.note})` : ''}`);
  }

  // 4. Google Sheets 기록
  console.log(`\n--- Google Sheets 기록 ---`);

  let attendanceRows = existingRows;

  // check-in과 check-out을 구분해서 시트에 추가
  const checkinRecords = records.filter(r => r.type === 'check-in');
  const checkoutRecords = records.filter(r => r.type === 'check-out');

  if (checkinRecords.length > 0) {
    console.log(`\n[출근 기록] ${checkinRecords.length}건`);
    await sheets.appendRecords(sheetName, checkinRecords, attendanceRows);

    // append 후 시트를 다시 읽어서 새로운 row 번호 확보
    attendanceRows = await sheets.readAll(sheetName);
  }

  if (checkoutRecords.length > 0) {
    console.log(`[퇴근 기록] ${checkoutRecords.length}건`);
    await sheets.appendRecords(sheetName, checkoutRecords, attendanceRows);
    attendanceRows = await sheets.readAll(sheetName);
  }

  // 퇴근시간 업데이트: 기존 출근기록에 퇴근시간 덧붙이기
  if (checkoutRecords.length > 0 && attendanceRows && attendanceRows.length > 1) {
    for (const co of checkoutRecords) {
      const timeStr = formatTimeDisplay(co.timestamp);

      // 가장 최근 출근기록 찾기 (이름이 같고, 날짜가 같고, 퇴근시간이 비어있는 row)
      let targetRowIdx = -1;
      for (let i = attendanceRows.length - 1; i >= 1; i--) {
        const row = attendanceRows[i];
        if (row[1] === co.name && row[0] === today && (!row[3] || row[3] === '')) {
          targetRowIdx = i + 1; // Sheets는 1-based, header가 1행
          break;
        }
      }

      if (targetRowIdx > 0) {
        await sheets.sheets.spreadsheets.values.update({
          spreadsheetId: sheets.sheetId,
          range: `'${sheetName}'!D${targetRowIdx}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[timeStr]] },
        });
        console.log(`[Update] ${co.name} 퇴근시간 업데이트: ${timeStr} (Row ${targetRowIdx})`);
      } else {
        console.log(`[Update] ${co.name} 퇴근시간(${timeStr}): 일치하는 출근 row 없음 (출근기록이 시트에 없는 날)`);
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`  ✅ Slack 출퇴근 로거 완료`);
  console.log(`  📊 처리: ${records.length}건`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('\n❌ 실행 중 오류 발생:', err);
  process.exit(1);
});