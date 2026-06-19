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

if (!CONFIG.sheets.sheetNames) {
  CONFIG.sheets.sheetNames = { 
    // 열 구조가 바뀌었으므로 새 시트(v2)를 생성하여 꼬임을 방지합니다.
    attendance: '출퇴근기록_v2',
    employee: '사원마스터'
  };
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

function timeStringToMinutes(timeStr) {
  if (!timeStr) return 0;
  const match = timeStr.match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  let h = parseInt(match[2], 10);
  let m = parseInt(match[3], 10);
  if (match[1] === '오후' && h !== 12) h += 12;
  if (match[1] === '오전' && h === 12) h = 0;
  return h * 60 + m;
}

function normalizeSheetDate(val) {
  if (!val) return '';
  const strVal = String(val).trim();
  if (/^\d{5}$/.test(strVal)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + parseInt(strVal) * 86400000);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  let clean = strVal.replace(/[\.\/]/g, '-').replace(/\s/g, '');
  if (clean.endsWith('-')) clean = clean.slice(0, -1);
  return clean.length === 10 ? clean : strVal;
}

function cleanUserName(rawName) {
  if (!rawName) return '알 수 없음';
  return rawName.replace(/\s*[\(\[\{<].*?[\)\]\}>]\s*/g, '').trim();
}

// ─────────────────── 상태/유형 추출 함수 ───────────────────
function extractStatus(text) {
  if (text.includes('반차')) return '반차';
  if (text.includes('연차')) return '연차';
  if (text.includes('휴가') || text.includes('명절') || text.includes('추석')) return '휴가';
  if (text.includes('결근')) return '결근';
  if (text.includes('지각')) return '지각';
  if (text.includes('조퇴')) return '조퇴';
  if (text.includes('퇴사')) return '퇴사';
  return '정상';
}

function extractWorkType(text, defaultType) {
  if (text.includes('재택')) return '재택';
  if (text.includes('유연')) return '유연';
  return defaultType;
}

function extractOvertime(text) {
  let overtime = '';
  let overtimeMins = '';
  if (text.includes('연장')) {
    overtime = 'O';
    let totalMins = 0;
    const hourMatch = text.match(/([0-9]+)\s*시간/);
    if (hourMatch) totalMins += parseInt(hourMatch[1], 10) * 60;
    const minMatch = text.match(/([0-9]+)\s*분/);
    if (minMatch) totalMins += parseInt(minMatch[1], 10);
    if (totalMins > 0) overtimeMins = String(totalMins);
  }
  return { overtime, overtimeMins };
}

// 메시지의 종류 판별
function getMessageType(text) {
  if (text.includes('퇴근') || text.includes('퇴사')) return 'check-out';
  if (text.includes('출근') || text.includes('반차') || text.includes('연차') || 
      text.includes('휴가') || text.includes('명절') || text.includes('결근')) return 'check-in';
  return 'other';
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
    return allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts)); // 과거순 정렬
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
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `'${sheetName}'!A:M` }); // 열 13개로 확장
    return res.data.values || [];
  }

  getLatestSlackTs(rows) {
    if (!rows || rows.length < 2) return null;
    let latest = 0;
    for (let i = 1; i < rows.length; i++) {
      const tsStr = String(rows[i][11] || ''); // K열(11)로 slack_ts 인덱스 이동
      if (!tsStr || tsStr.startsWith('auto')) continue;
      const ts = parseFloat(tsStr);
      if (!isNaN(ts) && ts > latest) latest = ts;
    }
    return latest === 0 ? null : String(latest);
  }

  async getEmployeeMaster() {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `'${CONFIG.sheets.sheetNames.employee}'!A:F`,
      });
      const rows = res.data.values || [];
      const employees = {};
      for (let i = 1; i < rows.length; i++) {
        const name = rows[i][0];
        if (name) {
          employees[name] = {
            status: rows[i][1] || '재직',
            joinDate: rows[i][2] || '2000-01-01',
            workType: rows[i][5] || '고정' 
          };
        }
      }
      return employees;
    } catch (err) {
      console.warn(`[Sheets] 사원마스터 로드 실패`);
      return {};
    }
  }

  async addEmployee(name, joinDate) {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `'${CONFIG.sheets.sheetNames.employee}'!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, '재직', joinDate, '', '자동등록', '고정']] },
    });
  }

  async sortSheet(sheetName) {
    try {
      const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
      const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheet) return;
      
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: [
            {
              sortRange: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: 1, 
                  startColumnIndex: 0,
                  endColumnIndex: 13 // 13개 열로 확장
                },
                sortSpecs: [
                  { dimensionIndex: 0, sortOrder: 'ASCENDING' }, // 날짜순
                  { dimensionIndex: 1, sortOrder: 'ASCENDING' }  // 이름순
                ]
              }
            }
          ]
        }
      });
      console.log(`[Sheets] 시트 정렬 완료: 날짜순 -> 이름순`);
    } catch (err) {
      console.error(`[Sheets] 정렬 실패:`, err.message);
    }
  }
}

// ─────────────────── 메인 로직 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 마스터 로거 v13.0 실행 (Split Cells)');
  console.log('========================================\n');

  const sheets = new SheetsClient();
  const sheetName = CONFIG.sheets.sheetNames.attendance;
  const masterSheetName = CONFIG.sheets.sheetNames.employee;
  
  // 헤더 구조를 13개로 확장 (출근 비고 / 퇴근 비고 / 기타 비고)
  const HEADERS = ['날짜', '이름', '출근시간', '퇴근시간', '근무유형', '상태', '연장', '연장시간(분)', '출근 비고', '퇴근 비고', '기타 비고', 'slack_ts', '출처'];
  
  await sheets.ensureSheet(sheetName, HEADERS);
  await sheets.ensureSheet(masterSheetName, ['이름', '상태', '입사일', '퇴사일', '비고', '근무제']);
  
  let existingRows = await sheets.readAll(sheetName);
  
  for (let i = 1; i < existingRows.length; i++) {
    existingRows[i][0] = normalizeSheetDate(existingRows[i][0]);
  }

  const lastTs = sheets.getLatestSlackTs(existingRows);
  console.log(`[Sheets] 기준 데이터: ${Math.max(0, existingRows.length - 1)}행 (마지막 실 TS: ${lastTs ?? '없음'})`);

  const slack = new SlackClient(CONFIG.slack.token);
  const userMap = await slack.getUsers();
  const masterMap = await sheets.getEmployeeMaster();
  
  const oldest = lastTs ? String(parseFloat(lastTs) + 0.000001) : '0';
  console.log(`\n--- Slack 채널 메시지 수집 중... ---`);
  const messages = await slack.fetchMessagesInRange(CONFIG.slack.channelId, oldest);
  
  // 1. 메시지 그룹화 (날짜 -> 이름 -> 메시지배열)
  const groupedMsgs = {};
  for (const msg of messages) {
    if (msg.subtype && msg.subtype !== 'message_changed') continue; 
    const text = msg.text?.trim() || '';
    if (!text) continue;

    const dateStr = getDateFromTs(msg.ts);
    const rawName = userMap[msg.user] || msg.user || '알 수 없음';
    const userName = cleanUserName(rawName);

    if (!masterMap[userName]) {
      console.log(`  [신규 등록] ${userName} 사원마스터에 추가 중...`);
      await sheets.addEmployee(userName, dateStr);
      masterMap[userName] = { status: '재직', joinDate: dateStr, workType: '고정' };
    }

    if (!groupedMsgs[dateStr]) groupedMsgs[dateStr] = {};
    if (!groupedMsgs[dateStr][userName]) groupedMsgs[dateStr][userName] = [];
    groupedMsgs[dateStr][userName].push(msg);
  }

  const todayStr = getDateFromTs(Date.now() / 1000);
  let minDateStr = todayStr;
  const msgDates = Object.keys(groupedMsgs).sort();
  if (msgDates.length > 0) minDateStr = msgDates[0];
  
  const rowDates = existingRows.slice(1).map(r => r[0]).filter(Boolean).sort();
  if (rowDates.length > 0 && rowDates[rowDates.length - 1] < minDateStr) {
    minDateStr = rowDates[rowDates.length - 1]; 
  }

  const allDays = [];
  for (let d = new Date(minDateStr); d <= new Date(todayStr); d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    allDays.push(`${y}-${m}-${day}`);
  }

  const toAppend = [];
  const toUpdate = [];
  const activeMembers = Object.keys(masterMap).filter(n => masterMap[n].status === '재직' || masterMap[n].status === 'active');
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const currentHour = nowKst.getUTCHours();

  console.log(`\n--- 날짜별 순회 적용 (시작: ${minDateStr} ~ 종료: ${todayStr}) ---`);

  // 3. 날짜 -> 직원 순으로 데이터 채워넣기
  for (const date of allDays) {
    for (const member of activeMembers) {
      if (date < masterMap[member].joinDate) continue;

      const msgs = groupedMsgs[date]?.[member] || [];
      const rowIdx = existingRows.findIndex(r => r[0] === date && r[1] === member);
      const row = rowIdx >= 0 ? existingRows[rowIdx] : null;

      if (msgs.length === 0) {
        if (!row) {
          if (date === todayStr && currentHour < 23) continue;
          
          const fakeTs = `auto-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          // 13개 열에 맞춤
          const newRow = [
            date, member, '', '', masterMap[member].workType, '확인(연차/결근)', '', '', '', '', '미보고 (자동생성)', fakeTs, 'slack-logger'
          ];
          toAppend.push(newRow);
          existingRows.push(newRow); 
        }
        continue;
      }

      // 메시지 종류별 분류
      let checkInTs = null, checkOutTs = null, lastTs = '';
      let inNotes = [], outNotes = [], otherNotes = [];
      
      const allText = msgs.map(m => m.text).join(' '); // 전체 텍스트 추출용

      for (const m of msgs) {
        const cleanText = m.text.replace(/\n/g, ' ');
        const type = getMessageType(cleanText);
        lastTs = m.ts;

        if (type === 'check-in') {
          if (!checkInTs) checkInTs = m.ts; // 최초 출근 시간 기록
          inNotes.push(cleanText);
        } else if (type === 'check-out') {
          checkOutTs = m.ts; // 가장 늦은 퇴근 시간으로 갱신
          outNotes.push(cleanText);
        } else {
          otherNotes.push(cleanText);
        }
      }

      const workType = extractWorkType(allText, masterMap[member].workType);
      let { overtime, overtimeMins } = extractOvertime(allText);
      const inStr = inNotes.join(' | ');
      const outStr = outNotes.join(' | ');
      const otherStr = otherNotes.join(' | ');

      if (!row) {
        // 완전 새 줄 추가
        let checkInTime = checkInTs ? formatTimeDisplay(checkInTs) : (otherNotes.length > 0 ? formatTimeDisplay(msgs[0].ts) : '');
        let checkOutTime = checkOutTs ? formatTimeDisplay(checkOutTs) : '';
        let status = extractStatus(allText);

        const newRow = [
          date, member, checkInTime, checkOutTime, workType, status, overtime, overtimeMins, inStr, outStr, otherStr, lastTs, 'slack-logger'
        ];
        toAppend.push(newRow);
        existingRows.push(newRow);
      } else {
        // 기존 행 업데이트
        while (row.length < 13) row.push('');
        
        if (checkInTs && !row[2]) row[2] = formatTimeDisplay(checkInTs);
        if (checkOutTs) row[3] = formatTimeDisplay(checkOutTs);

        // 기존 비고 내용과 병합 (자동생성 텍스트는 지움)
        if (row[10].includes('미보고')) row[10] = '';
        
        if (inStr) row[8] = row[8] ? `${row[8]} | ${inStr}` : inStr;
        if (outStr) row[9] = row[9] ? `${row[9]} | ${outStr}` : outStr;
        if (otherStr) row[10] = row[10] ? `${row[10]} | ${otherStr}` : otherStr;

        const combinedFullText = `${row[8]} ${row[9]} ${row[10]}`;
        row[5] = extractStatus(combinedFullText);
        row[4] = workType;
        row[6] = overtime;
        row[7] = overtimeMins;
        row[11] = lastTs; // K열

        // 짧은 근무 검사
        if (row[2] && row[3]) {
          const inMins = timeStringToMinutes(row[2]);
          const outMins = timeStringToMinutes(row[3]);
          const durationHours = (outMins - inMins) / 60;
          if (row[4] !== '아르바이트' && durationHours > 0 && durationHours < 6 && row[5] === '정상') {
            row[5] = '확인(반차/조퇴)';
          }
        }

        toUpdate.push({ range: `'${sheetName}'!C${rowIdx + 1}`, values: [[row[2]]] });
        toUpdate.push({ range: `'${sheetName}'!D${rowIdx + 1}`, values: [[row[3]]] });
        toUpdate.push({ range: `'${sheetName}'!E${rowIdx + 1}`, values: [[row[4]]] });
        toUpdate.push({ range: `'${sheetName}'!F${rowIdx + 1}`, values: [[row[5]]] });
        toUpdate.push({ range: `'${sheetName}'!G${rowIdx + 1}`, values: [[row[6]]] });
        toUpdate.push({ range: `'${sheetName}'!H${rowIdx + 1}`, values: [[row[7]]] });
        toUpdate.push({ range: `'${sheetName}'!I${rowIdx + 1}`, values: [[row[8]]] });
        toUpdate.push({ range: `'${sheetName}'!J${rowIdx + 1}`, values: [[row[9]]] });
        toUpdate.push({ range: `'${sheetName}'!K${rowIdx + 1}`, values: [[row[10]]] });
        toUpdate.push({ range: `'${sheetName}'!L${rowIdx + 1}`, values: [[row[11]]] });
      }
    }
  }

  if (toAppend.length > 0) {
    await sheets.sheets.spreadsheets.values.append({
      spreadsheetId: sheets.sheetId, 
      range: `'${sheetName}'!A:M`,
      valueInputOption: 'USER_ENTERED', 
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend },
    });
    console.log(`  [Sheets] 신규 ${toAppend.length}줄 추가 완료.`);
  }

  if (toUpdate.length > 0) {
    await sheets.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheets.sheetId, 
      requestBody: { valueInputOption: 'USER_ENTERED', data: toUpdate }
    });
    console.log(`  [Sheets] 기존 데이터 업데이트 완료.`);
  }

  await sheets.sortSheet(sheetName);

  console.log(`\n========================================`);
  console.log(`  ✅ 출퇴근 메시지 셀 분할 기록 완료!`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('\n❌ 실행 중 오류 발생:', err);
  process.exit(1);
});