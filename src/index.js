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
    attendance: '출퇴근기록_v4', 
    employee: '사원마스터'
  };
}

// ─────────────────── 상수 (휴일 & 요일) ───────────────────
const HOLIDAYS = {
  "2025-01-01": "신정", "2025-01-28": "설날", "2025-01-29": "설날", "2025-01-30": "설날",
  "2025-03-01": "삼일절", "2025-03-03": "대체공휴일", "2025-05-01": "근로자의 날", "2025-05-05": "어린이날", "2025-05-06": "대체공휴일(석가탄신일)",
  "2025-06-06": "현충일", "2025-07-17": "제헌절", "2025-08-15": "광복절", "2025-10-03": "개천절", "2025-10-05": "추석",
  "2025-10-06": "추석", "2025-10-07": "추석", "2025-10-08": "대체공휴일", "2025-10-09": "한글날", "2025-12-25": "성탄절",
  "2026-01-01": "신정", "2026-02-16": "설날", "2026-02-17": "설날", "2026-02-18": "설날",
  "2026-03-01": "삼일절", "2026-03-02": "대체공휴일", "2026-05-01": "근로자의 날", "2026-05-05": "어린이날", "2026-05-24": "석가탄신일",
  "2026-05-25": "대체공휴일", "2026-06-06": "현충일", "2026-07-17": "제헌절", "2026-08-15": "광복절", "2026-08-17": "대체공휴일",
  "2026-09-24": "추석", "2026-09-25": "추석", "2026-09-26": "추석", "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일", "2026-10-09": "한글날", "2026-12-25": "성탄절"
};
const DAY_NAMES = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

// ─────────────────── 유틸리티 및 분석 엔진 ───────────────────
function formatTimeFromMins(totalMinutes) {
  if (totalMinutes === undefined || totalMinutes === null) return '-';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getDateFromTs(ts) {
  const kst = new Date(parseFloat(ts) * 1000 + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

function getKstObj(ts) {
  return new Date(parseFloat(ts) * 1000 + 9 * 60 * 60 * 1000);
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

function normalizeSheetTime(val) {
  if (!val || val === '-') return '-';
  const strVal = String(val).trim();
  if (/^0\.\d+$/.test(strVal)) {
    const totalMinutes = Math.round(parseFloat(strVal) * 24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return strVal;
}

function cleanUserName(rawName) {
  if (!rawName) return '알 수 없음';
  return rawName.replace(/\s*[\(\[\{<].*?[\)\]\}>]\s*/g, '').trim();
}

function snapToNearestHour(minutes) {
  return Math.round(minutes / 60) * 60;
}

function extractTimeFromText(text, ts) {
  const times = [];
  const kstObj = getKstObj(ts);
  times.push(kstObj.getUTCHours() * 60 + kstObj.getUTCMinutes()); 

  if (text.includes('출근') || text.includes('입실')) {
    const timeRegex = /(\d{1,2})\s*[:시]\s*(\d{1,2})?/;
    const match = text.match(timeRegex);
    if (match) {
      let hour = parseInt(match[1], 10);
      let minute = match[2] ? parseInt(match[2], 10) : (text.includes('반') ? 30 : 0);
      if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
        times.push(hour * 60 + minute);
      }
    }
  }
  return times;
}

function extractLeaveStatus(text) {
  if (text.includes('연차')) return '연차';
  if (text.includes('반차')) return '반차';
  if (text.includes('휴가') || text.includes('명절') || text.includes('추석')) return '휴가';
  if (text.includes('조퇴')) return '조퇴';
  if (text.includes('결근')) return '결근';
  return '';
}

function analyzeFixed(startMin, endMin) {
  const workStart = 9 * 60; 
  const workEnd = 18 * 60; 
  let lateness = '정상';
  if (startMin > workStart) {
    lateness = startMin <= workStart + 10 ? '경미한 지각' : '지각';
  }
  let overtime = '없음';
  let overtimeHours = 0;
  if (endMin > workEnd) {
    const diff = endMin - workEnd;
    if (diff <= 30) overtime = '경미한 연장';
    else {
      overtime = '야근';
      overtimeHours = Math.floor(diff / 60);
    }
  }
  return { lateness, overtime, overtimeHours };
}

function analyzeFlexible(startMin, endMin) {
  const minStart = 8 * 60; 
  const maxStartLimit = 11 * 60; 
  let effectiveStart = startMin < minStart ? minStart : startMin;
  let lateness = startMin > maxStartLimit ? '지각' : '정상';
  const targetEnd = effectiveStart + (9 * 60);
  let overtime = '없음';
  let overtimeHours = 0;
  if (endMin > targetEnd) {
    const diff = endMin - targetEnd;
    if (diff <= 30) overtime = '경미한 연장';
    else {
      overtime = '야근';
      overtimeHours = Math.floor(diff / 60);
    }
  }
  return { lateness, overtime, overtimeHours };
}

function analyzePartTime(startMin, endMin) {
  const workStart = 9 * 60;
  const workEnd = 12 * 60;
  let lateness = '정상';
  if (startMin > workStart) {
    lateness = startMin <= workStart + 10 ? '경미한 지각' : '지각';
  }
  let overtime = '없음';
  let overtimeHours = 0;
  if (endMin > workEnd) {
    const diff = endMin - workEnd;
    if (diff <= 30) overtime = '경미한 연장';
    else {
      overtime = '야근';
      overtimeHours = Math.floor(diff / 60);
    }
  }
  return { lateness, overtime, overtimeHours };
}

// ─────────────────── Slack / Sheets 클라이언트 ───────────────────
class SlackClient {
  constructor(token) { this.token = token; }
  async call(method, params = {}) {
    const body = new URLSearchParams(params);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API 오류: ${data.error}`);
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
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `'${sheetName}'!A:L` });
    return res.data.values || [];
  }
  async getEmployeeMaster() {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId, range: `'${CONFIG.sheets.sheetNames.employee}'!A:F`,
      });
      const rows = res.data.values || [];
      const employees = {};
      for (let i = 1; i < rows.length; i++) {
        const name = rows[i][0];
        if (name) {
          employees[name] = {
            status: rows[i][1] || '재직', joinDate: rows[i][2] || '2000-01-01', workType: rows[i][5] || '고정' 
          };
        }
      }
      return employees;
    } catch (err) { return {}; }
  }
  async addEmployee(name, joinDate) {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId, range: `'${CONFIG.sheets.sheetNames.employee}'!A:F`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
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
          requests: [{
            sortRange: {
              range: { sheetId: sheet.properties.sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
              sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }, { dimensionIndex: 2, sortOrder: 'ASCENDING' }]
            }
          }]
        }
      });
    } catch (err) {}
  }
}

// ─────────────────── 메인 로직 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 스마트 로거 v17.1 (초기 전체 수집 탑재)');
  console.log('========================================\n');

  const sheets = new SheetsClient();
  const sheetName = CONFIG.sheets.sheetNames.attendance;
  const masterSheetName = CONFIG.sheets.sheetNames.employee;
  
  const HEADERS = ['날짜', '요일', '이름', '근무제', '상태', '휴가여부', '지각여부', '출근시간', '퇴근시간', '야근여부', '야근인정시간(시)', '비고'];
  await sheets.ensureSheet(sheetName, HEADERS);
  await sheets.ensureSheet(masterSheetName, ['이름', '상태', '입사일', '퇴사일', '비고', '근무제']);
  
  let existingRows = await sheets.readAll(sheetName);
  
  for (let i = 1; i < existingRows.length; i++) {
    existingRows[i][0] = normalizeSheetDate(existingRows[i][0]);
    existingRows[i][7] = normalizeSheetTime(existingRows[i][7]);
    existingRows[i][8] = normalizeSheetTime(existingRows[i][8]);
  }

  const slack = new SlackClient(CONFIG.slack.token);
  const userMap = await slack.getUsers();
  const masterMap = await sheets.getEmployeeMaster();
  
  // 💡 [핵심 업데이트] 시트가 비어있으면(초기 세팅) 전체 수집, 아니면 최근 30일 수집
  let oldest;
  if (existingRows.length < 5) { // 헤더만 있거나 데이터가 거의 없는 초기 상태
    console.log(`\n[안내] 시트 데이터가 없으므로 Slack '전체 기간' 메시지를 수집합니다! (최초 1회 한정)`);
    oldest = '0'; // 채널 생성일(0)부터 전체 가져오기
  } else {
    console.log(`\n[안내] 시트에 데이터가 존재하여 '최근 30일치' 데이터를 동기화합니다.`);
    oldest = String(Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)); // 최근 30일
  }

  const messages = await slack.fetchMessagesInRange(CONFIG.slack.channelId, oldest);
  
  const firstActiveDate = {};
  for (let i = 1; i < existingRows.length; i++) {
    const date = existingRows[i][0];
    const name = existingRows[i][2]; 
    const note = existingRows[i][11] || ''; 
    if (note.includes('미보고')) continue;
    if (date && name) {
      if (!firstActiveDate[name] || date < firstActiveDate[name]) firstActiveDate[name] = date;
    }
  }
  for (const msg of messages) {
    if (msg.subtype && msg.subtype !== 'message_changed') continue;
    const date = getDateFromTs(msg.ts);
    const rawName = userMap[msg.user] || msg.user;
    const name = cleanUserName(rawName);
    if (name && (!firstActiveDate[name] || date < firstActiveDate[name])) {
      firstActiveDate[name] = date;
    }
  }

  const groupedMsgs = {};
  for (const msg of messages) {
    if (msg.subtype && msg.subtype !== 'message_changed') continue; 
    const text = msg.text?.trim() || '';
    if (!text) continue;

    const dateStr = getDateFromTs(msg.ts);
    const userName = cleanUserName(userMap[msg.user] || msg.user);

    if (!masterMap[userName]) {
      const joinDate = firstActiveDate[userName] || dateStr;
      console.log(`  [신규 등록] ${userName} 사원마스터에 추가 중...`);
      await sheets.addEmployee(userName, joinDate);
      masterMap[userName] = { status: '재직', joinDate: joinDate, workType: '고정' };
    }

    if (!groupedMsgs[dateStr]) groupedMsgs[dateStr] = {};
    if (!groupedMsgs[dateStr][userName]) groupedMsgs[dateStr][userName] = [];
    groupedMsgs[dateStr][userName].push(msg);
  }

  const todayStr = getDateFromTs(Date.now() / 1000);
  let minDateStr = todayStr;
  const msgDates = Object.keys(groupedMsgs).sort();
  if (msgDates.length > 0) minDateStr = msgDates[0];
  
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

  for (const date of allDays) {
    const dObj = new Date(date);
    const dayOfWeek = dObj.getDay();
    const dayName = DAY_NAMES[dayOfWeek];
    const holidayName = HOLIDAYS[date];
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    for (const member of activeMembers) {
      const userJoinDate = firstActiveDate[member] || masterMap[member].joinDate;
      if (date < userJoinDate) continue;

      const msgs = groupedMsgs[date]?.[member] || [];
      const rowIdx = existingRows.findIndex(r => r[0] === date && r[2] === member); 
      const row = rowIdx >= 0 ? existingRows[rowIdx] : null;

      let rawWorkType = masterMap[member].workType;
      let workTypeKey = 'UNKNOWN';
      if (rawWorkType.includes('고정')) workTypeKey = 'FIXED';
      else if (rawWorkType.includes('유연')) workTypeKey = 'FLEXIBLE';
      else if (rawWorkType.includes('아르바이트')) workTypeKey = 'PART_TIME';

      const allText = msgs.map(m => m.text.replace(/\n/g, ' ')).join(' | ');
      let leaveStatus = extractLeaveStatus(allText);

      // (1) 결근 및 미보고 처리
      if (msgs.length === 0) {
        if (!row) {
          if (date === todayStr && currentHour < 23) continue; 
          
          let status = '결근';
          let note = '평일 (미보고)';
          if (holidayName) { status = '휴무'; note = `공휴일(${holidayName})`; }
          else if (isWeekend) { status = '휴무'; note = `주말(${dayName})`; }
          
          const newRow = [date, dayName, member, rawWorkType, status, leaveStatus, '-', '-', '-', '-', '0', note];
          toAppend.push(newRow);
          existingRows.push(newRow); 
        }
        continue;
      }

      // (2) 출근 기록 처리 (1시간 단위 정시 스냅핑 반영)
      let times = [];
      for (const m of msgs) times.push(...extractTimeFromText(m.text, m.ts));
      times.sort((a, b) => a - b);
      
      const rawStartMin = times[0];
      const endMin = times[times.length - 1];

      const startMin = snapToNearestHour(rawStartMin);

      let status = '출근';
      let note = allText;
      if (holidayName || isWeekend) {
        status = '휴일근무';
        note = `[${holidayName ? holidayName : dayName}] ` + allText;
      }
      if (leaveStatus === '연차' || leaveStatus === '반차') status = leaveStatus; 

      let analysis = { lateness: '-', overtime: '-', overtimeHours: 0 };
      if (workTypeKey === 'FIXED') analysis = analyzeFixed(startMin, endMin);
      else if (workTypeKey === 'FLEXIBLE') analysis = analyzeFlexible(startMin, endMin);
      else if (workTypeKey === 'PART_TIME') analysis = analyzePartTime(startMin, endMin);

      if (!row) {
        const newRow = [
          date, dayName, member, rawWorkType, status, leaveStatus, analysis.lateness, formatTimeFromMins(startMin), formatTimeFromMins(endMin), analysis.overtime, String(analysis.overtimeHours), note
        ];
        toAppend.push(newRow);
        existingRows.push(newRow);
      } else {
        while (row.length < 12) row.push('');
        
        row[1] = dayName;
        row[3] = rawWorkType;
        row[4] = status;
        row[5] = leaveStatus; 
        row[6] = analysis.lateness;
        row[7] = formatTimeFromMins(startMin);
        row[8] = formatTimeFromMins(endMin);
        row[9] = analysis.overtime;
        row[10] = String(analysis.overtimeHours);
        row[11] = note; 

        toUpdate.push({ range: `'${sheetName}'!B${rowIdx + 1}:L${rowIdx + 1}`, values: [row.slice(1, 12)] });
      }
    }
  }

  // 3. 일괄 쓰기 및 정렬 (RAW 강제하여 숫자 깨짐 방지)
  if (toAppend.length > 0) {
    await sheets.sheets.spreadsheets.values.append({
      spreadsheetId: sheets.sheetId, range: `'${sheetName}'!A:L`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: toAppend },
    });
  }

  if (toUpdate.length > 0) {
    await sheets.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheets.sheetId, requestBody: { valueInputOption: 'RAW', data: toUpdate }
    });
  }

  await sheets.sortSheet(sheetName);

  console.log(`\n========================================`);
  console.log(`  ✅ 출퇴근 기록 엔진 완벽 동기화 완료!`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('\n❌ 실행 중 오류 발생:', err);
  process.exit(1);
});