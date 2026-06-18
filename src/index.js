/**
 * slack-attendance-logger
 * =======================
 * Slack #출퇴근 채널 메시지를 수집 → 파싱 → Google Sheets 기록
 * GitHub Actions에서 10분마다 실행되는 stateless 배치 프로그램
 *
 * [Slack API Research Summary]
 * - Internal App + Pro Plan → 2025년 conversations.history 제한(1rpm/15msg) 대상 아님
 * - Tier 3: 50+ req/min 충분히 확보
 * - chat.postMessage: 채널당 ~1msg/sec
 * - Socket Mode 불필요 (GA는 stateless)
 */

// ============================================================
// 환경변수 (모두 GitHub Actions Secrets → env)
// ============================================================

const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',      // xoxb-... Slack Bot User OAuth Token
  'SLACK_CHANNEL_ID',     // #출퇴근 채널 ID (예: C123456)
  'GOOGLE_SERVICE_EMAIL', // Google Service Account email
  'GOOGLE_PRIVATE_KEY',   // Google Service Account private key
  'SHEET_ID',             // Google Sheets ID (스프레드시트 ID)
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] 환경변수 누락: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// Imports
// ============================================================

import fetch from 'node-fetch';
import { google } from 'googleapis';

// ============================================================
// Configuration
// ============================================================

const CONFIG = {
  slack: {
    token: process.env.SLACK_BOT_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    // 출퇴근 채널에서 캡처할 시계열 범위 (분)
    lookbackMinutes: parseInt(process.env.LOOKBACK_MINUTES || '30', 10),
  },
  sheets: {
    id: process.env.SHEET_ID,
    // 시트 이름들
    sheetNames: {
      attendance: '출퇴근기록',
      leave: '연월차현황',
      summary: '월별통계',
    },
  },
  // 근무 유형별 지각 기준 (분)
  lateThresholds: {
    flexible: { startMax: 11 * 60 }, // 11:00 = 660분 (08시 이후 출근 허용)
    fixed: { startMax: 9 * 60 + 10 }, // 09:10 (09:00 + 10분 예외)
  },
  // 표준 근무 시간 (분)
  standardWorkMinutes: 9 * 60, // 9시간
  halfVacationMinutes: 4 * 60, // 반차 = 4시간
};

// ============================================================
// Slack API Client
// ============================================================

class SlackClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://slack.com/api';
  }

  async call(method, params = {}) {
    const url = new URL(`${this.baseUrl}/${method}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    const data = await res.json();

    if (!data.ok) {
      throw new Error(`Slack API 오류 [${method}]: ${data.error}`);
    }
    return data;
  }

  /**
   * 특정 채널의 메시지 이력을 조회 (가장 최근 N분)
   * API Research: conversations.history (Tier 3, 50+ req/min)
   */
  async fetchRecentMessages(channelId, lookbackMinutes) {
    const oldest = Math.floor(Date.now() / 1000) - lookbackMinutes * 60;

    const result = await this.call('conversations.history', {
      channel: channelId,
      oldest,
      limit: 100,
    });

    console.log(`[Slack] ${result.messages.length}개 메시지 수신 (과거 ${lookbackMinutes}분)`);
    return result.messages;
  }

  /**
   * 각종 메타 조회 (채널명 확인 / 사용자 정보)
   */
  async getChannelInfo(channelId) {
    return this.call('conversations.info', { channel: channelId });
  }

  async getUserInfo(userId) {
    return this.call('users.info', { user: userId });
  }
}

// ============================================================
// Message Parser — Slack 메시지 → Attendance Record
// ============================================================

/**
 * 메시지 예시:
 *   "김혜경  [오전 8:23]"
 *   ↓ (다음 메시지)
 *   "출근했습니다"
 *
 *   "정호용(6/18 오후반차)  [오전 8:38]"
 *   ↓
 *   "출근했습니다"
 *
 *   "이용준  [오후 6:00]"
 *   ↓
 *   "퇴근하겠습니다"
 *
 * 위 예시는 한 사람이 2개의 메시지를 연속으로 보내는 패턴.
 * 실제로는 아래의 패턴도 가능:
 *   단일 메시지: "출근했습니다  [오전 8:23]"
 *
 * 현재 관측된 패턴을 기준으로 파싱:
 *   Message #1: "이름  [오전/오후 H:MM]"  — 타임스탬프 인사
 *   Message #2: "출근했습니다" / "퇴근하겠습니다"
 *
 * 혹은 같은 메시지에 시간과 출근선언이 함께 있는 경우도 처리
 */

const TIME_REGEX = /\[(오전|오후)\s*(\d{1,2}):(\d{2})\]/;
const NAME_REGEX = /^([가-힣a-zA-Z]{2,10})/;
const NOTE_REGEX = /\((.*?)\)/; // 괄호 안 메모
const CHECK_IN_KEYWORDS = ['출근했습니다', '출근', '업무시작'];
const CHECK_OUT_KEYWORDS = ['퇴근하겠습니다', '퇴근', '업무종료'];

/**
 * "[오전 8:23]" → { hour: 8, minute: 23, isPM: false }
 */
function parseTimeTag(text) {
  const match = text.match(TIME_REGEX);
  if (!match) return null;
  const [, period, hourStr, minStr] = match;
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  if (period === '오후' && hour !== 12) hour += 12;
  if (period === '오전' && hour === 12) hour = 0;
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

/**
 * "정호용(6/18 오후반차)" → { name: "정호용", note: "6/18 오후반차" }
 */
function parseNameAndNote(text) {
  const nameMatch = text.match(NAME_REGEX);
  const noteMatch = text.match(NOTE_REGEX);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    note: noteMatch ? noteMatch[1].trim() : null,
  };
}

/**
 * 메시지가 어떤 유형인지 판별
 */
function classifyMessage(text) {
  const lower = text.toLowerCase();
  for (const kw of CHECK_IN_KEYWORDS) {
    if (lower.includes(kw)) return 'check-in';
  }
  for (const kw of CHECK_OUT_KEYWORDS) {
    if (lower.includes(kw)) return 'check-out';
  }
  return 'info'; // 시간표시 메시지 등
}

/**
 * 전체 메시지 목록을 순회하며 출퇴근 레코드로 파싱
 *
 * 파싱 전략 (관측된 패턴 기반):
 *   [이름+시간] 메시지와 [출근/퇴근 선언] 메시지가 쌍으로 나타남.
 *   동일 사용자의 연속 메시지를 하나의 레코드로 결합.
 */
function parseMessages(messages) {
  const records = [];
  let pending = null; // { name, note, time, ts, user }

  for (const msg of messages) {
    const text = msg.text || '';
    const type = classifyMessage(text);
    const timeTag = parseTimeTag(text);
    const { name, note } = parseNameAndNote(text);

    // 시간 태그가 있는 메시지 = 새로운 pending 생성
    if (timeTag) {
      // 이전 pending 미완료 시 폐기
      if (pending) {
        console.warn(`[WARN] 미완료 pending 폐기: ${pending.name} (${pending.ts})`);
      }
      pending = {
        name: name || msg.user,
        note: note,
        time: timeTag,
        ts: msg.ts,
        user: msg.user,
      };
      continue;
    }

    // 출근/퇴근 선언 메시지
    if (type === 'check-in' || type === 'check-out') {
      // 바로 직전 pending이 있다면 결합
      // (같은 사용자가 연속으로 보낸 메시지라고 가정)
      if (pending) {
        records.push({
          name: pending.name,
          note: pending.note,
          timestamp: pending.time,
          type,
          slackTs: msg.ts,
          rawTimeText: text,
        });
        pending = null;
      } else {
        // pending 없이 "출근했습니다"만 온 경우 → 메시지 자체의 ts로 시간 추정
        const fallbackTime = new Date(parseFloat(msg.ts) * 1000);
        records.push({
          name: name || msg.user,
          note,
          timestamp: {
            hour: fallbackTime.getHours(),
            minute: fallbackTime.getMinutes(),
            totalMinutes: fallbackTime.getHours() * 60 + fallbackTime.getMinutes(),
          },
          type,
          slackTs: msg.ts,
          rawTimeText: text,
        });
      }
    }
  }

  return records;
}

// ============================================================
// Attendance Record → 다양한 상태 판정
// ============================================================

/**
 * 근무 유형 판별 (유연근무제 vs 고정근무제)
 * TODO: 사용자별 설정을 DB나 시트에서 읽어오는 것으로 확장 가능
 * 현재는 일괄 유연근무제 가정 (계획서 기준 대부분 유연)
 */
function determineWorkType(name) {
  // 고정근무 예외 처리 (계획서 reference)
  const fixedWorkUsers = []; // 필요시 명단 추가
  return fixedWorkUsers.includes(name) ? 'fixed' : 'flexible';
}

/**
 * 출근 시간 기준 지각 판정
 */
function determineAttendanceStatus(record, workType) {
  const minutes = record.timestamp.totalMinutes;
  const threshold = CONFIG.lateThresholds[workType].startMax;

  if (record.type === 'check-in') {
    // 오전 4시 이전 기록은 전날 심야근무로 간주
    if (minutes < 4 * 60) return '야근익일';
    if (minutes <= threshold) return '정상';
    return '지각';
  }

  // check-out (퇴근)
  return '정상';
}

function formatTimeDisplay(timestamp) {
  const h = timestamp.hour;
  const m = String(timestamp.minute).padStart(2, '0');
  const period = h < 12 ? '오전' : '오후';
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${period} ${displayHour}:${m}`;
}

// ============================================================
// Google Sheets Client
// ============================================================

class SheetsClient {
  constructor() {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.sheetId = process.env.SHEET_ID;
  }

  /**
   * 시트 존재 확인, 없으면 생성
   */
  async ensureSheet(sheetName, headerRow) {
    try {
      const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
      const existing = res.data.sheets.map(s => s.properties.title);
      if (!existing.includes(sheetName)) {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.sheetId,
          requestBody: {
            requests: [{
              addSheet: { properties: { title: sheetName } },
            }],
          },
        });
        // 헤더 쓰기
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: `'${sheetName}'!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headerRow] },
        });
        console.log(`[Sheets] 시트 생성: ${sheetName}`);
      }
    } catch (err) {
      // 시트가 없음 → 생성
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: [{
            addSheet: { properties: { title: sheetName } },
          }],
        },
      });
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: `'${sheetName}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headerRow] },
      });
      console.log(`[Sheets] 시트 생성: ${sheetName}`);
    }
  }

  /**
   * 모든 데이터를 한 번에 읽기
   */
  async readAll(sheetName) {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `'${sheetName}'!A:G`,
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

    // 중복 검사: 기존 데이터의 slack_ts(column G)와 비교
    const existingTsSet = new Set();
    if (existingRows && existingRows.length > 1) {
      // header skip
      for (let i = 1; i < existingRows.length; i++) {
        const ts = existingRows[i][6]; // G열 = slack_ts
        if (ts) existingTsSet.add(ts);
      }
    }

    const toAppend = newRows.filter(r => !existingTsSet.has(r.slackTs));
    if (toAppend.length === 0) {
      console.log(`[Sheets] 중복 제거 후 추가할 데이터 없음`);
      return;
    }

    const values = toAppend.map(r => [
      r.date,               // A: 날짜
      r.name,               // B: 이름
      r.type === 'check-in' ? formatTimeDisplay(r.timestamp) : '',  // C: 출근시간
      r.type === 'check-out' ? formatTimeDisplay(r.timestamp) : '', // D: 퇴근시간
      r.workType === 'flexible' ? '유연' : '고정',                  // E: 근무유형
      r.status,             // F: 상태
      r.note || '',         // G: 비고
      r.slackTs,            // H: Slack TS (중복방지용, 숨김가능)
    ]);

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `'${sheetName}'!A:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    console.log(`[Sheets] ${toAppend.length}개 레코드 추가 완료`);
  }
}

// ============================================================
// Main Routine
// ============================================================

async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 로거 v1.0 실행');
  console.log('========================================\n');

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  console.log(`[TIME] 실행: ${now.toISOString()}`);

  // 1. Slack 메시지 수집
  const slack = new SlackClient(CONFIG.slack.token);
  console.log(`\n--- Slack 채널 메시지 수집 ---`);

  const channelInfo = await slack.getChannelInfo(CONFIG.slack.channelId);
  console.log(`[Slack] 채널: ${channelInfo.channel.name} (ID: ${CONFIG.slack.channelId})`);

  const messages = await slack.fetchRecentMessages(
    CONFIG.slack.channelId,
    CONFIG.lookbackMinutes
  );

  if (messages.length === 0) {
    console.log('[INFO] 수집된 메시지 없음. 종료합니다.');
    return;
  }

  // slack_ts 기준 내림차순(최신 우선) → 오름차순(오래된 순) 정렬
  messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  // 2. 메시지 파싱
  console.log(`\n--- 메시지 파싱 ---`);
  const records = parseMessages(messages);

  if (records.length === 0) {
    console.log('[INFO] 파싱된 출퇴근 기록 없음.');
    return;
  }

  console.log(`[Parse] 총 ${records.length}개 레코드 파싱 완료`);
  for (const r of records) {
    const workType = determineWorkType(r.name);
    const status = determineAttendanceStatus(r, workType);
    r.date = today;
    r.workType = workType;
    r.status = status;
    r.note = r.note || '';

    const timeStr = formatTimeDisplay(r.timestamp);
    const typeStr = r.type === 'check-in' ? '▶ 출근' : '◀ 퇴근';
    console.log(`  ${r.name.padEnd(8)} ${typeStr} ${timeStr.padEnd(12)} [${status}]${r.note ? ` (${r.note})` : ''}`);
  }

  // 3. Google Sheets 기록
  console.log(`\n--- Google Sheets 기록 ---`);

  const sheets = new SheetsClient();

  const headerRow = ['날짜', '이름', '출근시간', '퇴근시간', '근무유형', '상태', '비고', 'slack_ts'];

  // 출퇴근기록 시트
  await sheets.ensureSheet('출퇴근기록', headerRow);
  let currentAttendance = await sheets.readAll('출퇴근기록');

  // check-in과 check-out을 구분해서 시트에 추가
  const checkinRecords = records.filter(r => r.type === 'check-in');
  const checkoutRecords = records.filter(r => r.type === 'check-out');

  if (checkinRecords.length > 0) {
    console.log(`\n[출근 기록] ${checkinRecords.length}건`);
    await sheets.appendRecords('출퇴근기록', checkinRecords, currentAttendance);

    // append 후 시트를 다시 읽어서 새로운 row 번호 확보
    currentAttendance = await sheets.readAll('출퇴근기록');
  }

  if (checkoutRecords.length > 0) {
    console.log(`[퇴근 기록] ${checkoutRecords.length}건`);
    // checkout 기록은 별도 시트 추가 없이 기존 출근 row에 퇴근시간 업데이트
    // (단, check-in 없이 퇴근만 있는 경우에는 append)
    await sheets.appendRecords('출퇴근기록', checkoutRecords, currentAttendance);
    currentAttendance = await sheets.readAll('출퇴근기록');
  }

  // 퇴근시간 업데이트: 기존 출근기록에 퇴근시간 덧붙이기
  // 이미 appendRecords에서 slack_ts 중복 검사를 했으므로
  // 현재 시트에서 같은 사람/날짜의 비어있는 출근 row를 찾아 업데이트
  if (checkoutRecords.length > 0 && currentAttendance && currentAttendance.length > 1) {
    for (const co of checkoutRecords) {
      const timeStr = formatTimeDisplay(co.timestamp);

      // 가장 최근 출근기록 찾기 (이름이 같고, 날짜가 같고, 퇴근시간이 비어있는 row)
      let targetRowIdx = -1;
      for (let i = currentAttendance.length - 1; i >= 1; i--) {
        const row = currentAttendance[i];
        if (row[1] === co.name && row[0] === today && (!row[3] || row[3] === '')) {
          targetRowIdx = i + 1; // Sheets는 1-based, header가 1행
          break;
        }
      }

      if (targetRowIdx > 0) {
        await sheets.sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.sheets.id,
          range: `'출퇴근기록'!D${targetRowIdx}`,
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