import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import crypto from 'crypto'; // 해시 생성을 위한 모듈 추가

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
    attendance: '출퇴근기록', 
    employee: '사원마스터',
    calendar: '캘린더마스터'
  };
} else if (!CONFIG.sheets.sheetNames.calendar) {
  CONFIG.sheets.sheetNames.calendar = '캘린더마스터';
}
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
function getYesterdayDateStr(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
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
    return formatTimeFromMins(totalMinutes);
  }
  return strVal;
}
function getLeaveTypeByTenure(joinDateStr, currentDateStr) {
  if (!joinDateStr || !currentDateStr) return '-';
  try {
    const join = new Date(joinDateStr);
    const current = new Date(currentDateStr);
    const oneYearLater = new Date(join);
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    return current >= oneYearLater ? '연차' : '월차';
  } catch (e) { return '-'; }
}
function cleanUserName(rawName) {
  if (!rawName) return '알 수 없음';
  return rawName.replace(/\s*[\(\[\{<].*?[\)\]\}>]\s*/g, '').trim();
}
function snapToNearestHour(minutes) {
  return Math.round(minutes / 60) * 60;
}
function extractTimeFromText(text, ts, isMidnightShift = false) {
  const times = [];
  const kstObj = getKstObj(ts);
  let baseMinutes = kstObj.getUTCHours() * 60 + kstObj.getUTCMinutes();
  
  if (isMidnightShift) {
    baseMinutes += 24 * 60;
  }
  times.push(baseMinutes); 

  if (text.includes('출근') || text.includes('입실')) {
    const timeRegex = /(\d{1,2})\s*[:시]\s*(\d{1,2})?/;
    const match = text.match(timeRegex);
    if (match) {
      let hour = parseInt(match[1], 10);
      let minute = match[2] ? parseInt(match[2], 10) : (text.includes('반') ? 30 : 0);
      if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
        let textMins = hour * 60 + minute;
        if (isMidnightShift && hour < 5) textMins += 24 * 60;
        times.push(textMins);
      }
    }
  }
  return times;
}
function extractLeaveStatus(text) {
  let cleanText = text.replace(/(내일|익일|모레|다음주|차주|다음 주|월요일|화요일|수요일|목요일|금요일)[^.!|\n]*(휴가|연차|월차|반차|조퇴|결근|예비군|민방위)/g, '');
  cleanText = cleanText.replace(/(휴가|연차|월차|반차|조퇴|결근|예비군|민방위)[^.!|\n]*(예정|계획)/g, '');
  cleanText = cleanText.replace(/(즐거|행복|좋은|잘|건강|풀|풀충전)[^.!|\n]*(명절|추석|연휴|휴가|주말)/g, '');
  cleanText = cleanText.replace(/(명절|추석|연휴|휴가|주말)[^.!|\n]*(보내|되|쉬|다녀|만나|뵙|충전)/g, '');

  if (cleanText.includes('오전반차') || cleanText.includes('오전 반차')) return '오전반차';
  if (cleanText.includes('오후반차') || cleanText.includes('오후 반차')) return '오후반차';
  if (cleanText.includes('반차')) return '반차';
  
  if (cleanText.includes('연차')) return '연차';
  if (cleanText.includes('월차')) return '월차'; 
  if (cleanText.includes('휴가') || cleanText.includes('명절') || cleanText.includes('추석') || cleanText.includes('연휴')) return '휴가';
  if (cleanText.includes('조퇴')) return '조퇴';
  if (cleanText.includes('결근')) return '결근';
  if (cleanText.includes('예비군')) return '예비군';
  if (cleanText.includes('민방위')) return '민방위';
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
    if (diff <= 10) overtime = '없음'; 
    else if (diff <= 30) overtime = '경미한 연장'; 
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
    if (diff <= 10) overtime = '없음';
    else if (diff <= 30) overtime = '경미한 연장';
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
    if (diff <= 10) overtime = '없음';
    else if (diff <= 30) overtime = '경미한 연장';
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
  async getBotUserId() {
    const res = await this.call('auth.test');
    return res.user_id;
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
    const auth = new google.auth.JWT(CONFIG.sheets.serviceEmail, null, CONFIG.sheets.privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
    this.sheets = google.sheets({ version: 'v4', auth });
    this.sheetId = CONFIG.sheets.sheetId;
  }
  async ensureSheet(sheetName, headerRow) {
    const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    if (res.data.sheets.some(s => s.properties.title === sheetName)) return;
    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.sheetId, requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] } });
    await this.sheets.spreadsheets.values.update({ spreadsheetId: this.sheetId, range: `'${sheetName}'!A1`, valueInputOption: 'RAW', requestBody: { values: [headerRow] } });
  }
  async readAll(sheetName) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `'${sheetName}'!A:M` }); 
    return res.data.values || [];
  }
  async getHolidays() {
    try {
      const sheetName = CONFIG.sheets.sheetNames.calendar;
      const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `'${sheetName}'!A:D` });
      const rows = res.data.values || [];
      const holidays = {};
      for (let i = 1; i < rows.length; i++) {
        const dateStr = normalizeSheetDate(rows[i][0]);
        const division = (rows[i][1] || '').trim();
        const name = rows[i][2] || '휴무';
        if (dateStr && (division === '공휴일' || division === '회사지정휴일' || division === '휴무')) {
          holidays[dateStr] = name;
        }
      }
      return holidays;
    } catch (err) {
      console.warn('⚠️ 캘린더마스터 시트를 읽지 못했습니다. 기본 평일로 계산됩니다.');
      return {};
    }
  }
  async getEmployeeMaster() {
    try {
      const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `'${CONFIG.sheets.sheetNames.employee}'!A:G` });
      const rows = res.data.values || [];
      const employees = {};
      for (let i = 1; i < rows.length; i++) {
        const name = rows[i][0];
        if (name) {
          employees[name] = { 
            rowIndex: i + 1,
            status: rows[i][1] || '재직', 
            joinDate: rows[i][2] || '2000-01-01', 
            leaveDate: rows[i][3] || '',
            workType: rows[i][5] || '고정', 
            birthday: rows[i][6] ? rows[i][6].trim() : '' 
          };
        }
      }
      return employees;
    } catch (err) { return {}; }
  }
  async addEmployee(name, joinDate) {
    await this.sheets.spreadsheets.values.append({ spreadsheetId: this.sheetId, range: `'${CONFIG.sheets.sheetNames.employee}'!A:G`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[name, '재직', joinDate, '', '자동등록', '고정', '']] } });
  }
  async sortSheet(sheetName) {
    try {
      const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
      const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheet) return;
      await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.sheetId, requestBody: { requests: [{ sortRange: { range: { sheetId: sheet.properties.sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 }, sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }, { dimensionIndex: 2, sortOrder: 'ASCENDING' }] } }] } });
    } catch (err) {}
  }
}

// ─────────────────── 메인 로직 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 스마트 로거 v22.0 (초강력 풀 스위퍼 - 서버리스 해시 감지 탑재)');
  console.log('========================================\n');

  const sheets = new SheetsClient();
  const masterSheetName = CONFIG.sheets.sheetNames.employee;
  const HEADERS = ['날짜', '요일', '이름', '근무제', '상태', '지각여부', '출근시간', '실제출근시간', '퇴근시간', '야근여부', '야근인정시간(시)', '휴가/연월차구분', '비고'];
  await sheets.ensureSheet(masterSheetName, ['이름', '상태', '입사일', '퇴사일', '비고', '근무제', '생일(MM-DD)']);

  const holidaysMap = await sheets.getHolidays();
  const slack = new SlackClient(CONFIG.slack.token);
  const botUserId = await slack.getBotUserId();
  const userMap = await slack.getUsers();
  
  const nameToSlackId = {};
  for (const [id, name] of Object.entries(userMap)) {
    nameToSlackId[cleanUserName(name)] = id;
  }

  const nowMs = Date.now() + 9 * 60 * 60 * 1000;
  const currentYear = new Date(nowMs).getFullYear();
  let isInitialRun = true;

  try {
    const testSheetName = `${CONFIG.sheets.sheetNames.attendance}_${currentYear}`;
    const testRes = await sheets.sheets.spreadsheets.values.get({ spreadsheetId: sheets.sheetId, range: `'${testSheetName}'!A1:A5` });
    if (testRes.data.values && testRes.data.values.length >= 2) {
      isInitialRun = false;
    }
  } catch (e) {
    isInitialRun = true; 
  }

  const masterMap = await sheets.getEmployeeMaster();

  // 🟢 [추가] 마스터 데이터 해시(Hash) 생성 및 비교 로직 ──────────────────
  const currentMasterData = JSON.stringify(masterMap) + JSON.stringify(holidaysMap);
  const currentHash = crypto.createHash('sha256').update(currentMasterData).digest('hex');

  await sheets.ensureSheet('시스템설정', ['설정명', '값', '설명']);
  const sysRows = await sheets.readAll('시스템설정');
  let savedHash = '';
  let hashRowIndex = -1;

  for (let i = 1; i < sysRows.length; i++) {
    if (sysRows[i][0] === 'MASTER_HASH') {
      savedHash = sysRows[i][1];
      hashRowIndex = i + 1;
      break;
    }
  }

  const needsFullReconcile = (currentHash !== savedHash) || isInitialRun;

  if (needsFullReconcile) {
    console.log('🔄 [풀 스위퍼] 사원/캘린더 마스터 변경이 감지되었습니다. 과거 전체 데이터를 검증합니다...');
  } else {
    console.log('✅ 마스터 데이터 변경 없음. 풀 스위퍼를 생략하고 최근 기록만 동기화합니다.');
  }
  // ─────────────────────────────────────────────────────────────

  const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;
  let oldest = isInitialRun ? '0' : String(Math.floor(Date.now() / 1000) - THIRTY_DAYS_SEC);
  const messages = await slack.fetchMessagesInRange(CONFIG.slack.channelId, oldest);

  const sheetMetadata = await sheets.sheets.spreadsheets.get({ spreadsheetId: sheets.sheetId });
  const targetYearsSet = new Set();
  
  sheetMetadata.data.sheets.forEach(s => {
    const title = s.properties.title;
    if (title.startsWith(CONFIG.sheets.sheetNames.attendance + '_')) {
      const y = parseInt(title.split('_')[1]);
      if (!isNaN(y)) targetYearsSet.add(y);
    }
  });
  
  if (isInitialRun) {
    for (const msg of messages) {
      const yyyy = new Date(parseFloat(msg.ts) * 1000 + 9 * 60 * 60 * 1000).getFullYear();
      targetYearsSet.add(yyyy);
    }
  }
  
  targetYearsSet.add(currentYear);
  const targetYears = Array.from(targetYearsSet).sort();

  const sheetData = {}; 
  const toAppendByYear = {}; 
  const toUpdateByYear = {}; 

  for (const year of targetYears) {
    const sName = `${CONFIG.sheets.sheetNames.attendance}_${year}`;
    await sheets.ensureSheet(sName, HEADERS);
    let rows = await sheets.readAll(sName);
    
    for (let i = 1; i < rows.length; i++) {
      rows[i][0] = normalizeSheetDate(rows[i][0]);
      if (rows[i][6]) rows[i][6] = normalizeSheetTime(rows[i][6]);
      if (rows[i][7]) rows[i][7] = normalizeSheetTime(rows[i][7]);
      if (rows[i][8]) rows[i][8] = normalizeSheetTime(rows[i][8]);
    }
    sheetData[year] = { sheetName: sName, existingRows: rows };
    toAppendByYear[year] = [];
    toUpdateByYear[year] = [];
  }

  const firstActiveDate = {};
  const lastActiveDate = {};

  for (const year of targetYears) {
    const rows = sheetData[year].existingRows;
    for (let i = 1; i < rows.length; i++) {
      const date = rows[i][0];
      const name = rows[i][2];
      if (date && name && !(rows[i][11] || '').includes('미보고')) {
        if (!firstActiveDate[name] || date < firstActiveDate[name]) firstActiveDate[name] = date;
      }
      if (date && name && !['결근', '휴무', '-'].includes(rows[i][4])) {
        if (!lastActiveDate[name] || date > lastActiveDate[name]) lastActiveDate[name] = date;
      }
    }
  }

  const groupedMsgs = {};
  for (const msg of messages) {
    if (msg.bot_id || msg.subtype === 'bot_message') continue; 
    if (msg.subtype && !['message_changed', 'file_share'].includes(msg.subtype)) continue; 

    const text = msg.text?.trim() || '';
    if (!text) continue;

    const dateStr = getDateFromTs(msg.ts);
    const userName = cleanUserName(userMap[msg.user] || msg.user);
    if (!userName) continue;

    if (!masterMap[userName]) {
      const joinDate = firstActiveDate[userName] || dateStr;
      await sheets.addEmployee(userName, joinDate);
      masterMap[userName] = { status: '재직', joinDate: joinDate, workType: '고정', birthday: '', leaveDate: '' };
    }

    const kstObj = getKstObj(msg.ts);
    const hour = kstObj.getUTCHours();
    const isClockOutMsg = text.includes('퇴근') || text.includes('퇴실');
    
    let targetDateStr = dateStr;
    let isMidnightShift = false;

    if (hour >= 0 && hour < 5 && isClockOutMsg && !text.includes('출근정정')) {
      targetDateStr = getYesterdayDateStr(dateStr);
      isMidnightShift = true;
    }

    const dateMatch = text.match(/\[퇴근정정\]\s*(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})\s+(\d{1,2})[:시]\s*(\d{1,2})?/);
    const timeMatch = text.match(/\[퇴근정정\]\s*(\d{1,2})[:시]\s*(\d{1,2})?/);

    if (dateMatch) {
      const year = dateMatch[1] || new Date(parseFloat(msg.ts) * 1000 + 9 * 60 * 60 * 1000).getFullYear();
      targetDateStr = `${year}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
      msg.isCorrection = true;
      let hr = parseInt(dateMatch[4], 10);
      msg.correctionTime = hr * 60 + (dateMatch[5] ? parseInt(dateMatch[5], 10) : 0);
      if (hr < 5) msg.correctionTime += 24 * 60; 
    } else if (timeMatch) {
      msg.isCorrection = true;
      let hr = parseInt(timeMatch[1], 10);
      msg.correctionTime = hr * 60 + (timeMatch[2] ? parseInt(timeMatch[2], 10) : 0);
      if (hr < 5 && (hour >= 0 && hour < 6)) hr += 24; 
      else if (hr < 5) hr += 24; 
      msg.correctionTime = hr * 60 + (timeMatch[2] ? parseInt(timeMatch[2], 10) : 0);
    }

    if (!lastActiveDate[userName] || targetDateStr > lastActiveDate[userName]) {
      if (!text.includes('결근') && !text.includes('연차')) lastActiveDate[userName] = targetDateStr;
    }

    msg.isMidnightShift = isMidnightShift;
    if (!groupedMsgs[targetDateStr]) groupedMsgs[targetDateStr] = {};
    if (!groupedMsgs[targetDateStr][userName]) groupedMsgs[targetDateStr][userName] = [];
    groupedMsgs[targetDateStr][userName].push(msg);
  }

  const todayStr = getDateFromTs(Date.now() / 1000);
  const limitDateObj = new Date(nowMs - (30 * 24 * 60 * 60 * 1000));
  const limitDateStr = `${limitDateObj.getFullYear()}-${String(limitDateObj.getMonth() + 1).padStart(2, '0')}-${String(limitDateObj.getDate()).padStart(2, '0')}`;
  
  let minDateStr = isInitialRun ? (Object.keys(groupedMsgs).sort()[0] || todayStr) : limitDateStr;
  
  const allDays = [];
  for (let d = new Date(minDateStr); d <= new Date(todayStr); d.setDate(d.getDate() + 1)) {
    allDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  const dmQueue = [];
  const targetMembers = Object.keys(masterMap).filter(n => !masterMap[n].workType.includes('CEO'));
  const currentHour = new Date(nowMs).getUTCHours(); 
  const currentMinute = new Date(nowMs).getUTCMinutes();
  
  const updatedMasterMap = await sheets.getEmployeeMaster();
  for (const member of Object.keys(updatedMasterMap)) {
    if (masterMap[member]) masterMap[member].rowIndex = updatedMasterMap[member].rowIndex;
  }

  const masterUpdates = [];
  const todayObj = new Date(todayStr);

  for (const member of targetMembers) {
    const emp = masterMap[member];
    let isAlreadyResigned = (emp.status === '퇴사' || emp.status === '퇴사자');
    let needsLeaveDate = isAlreadyResigned && !emp.leaveDate;

    if (emp.status === '재직' || emp.status === 'active' || needsLeaveDate) {
      let isResigned = false;
      let lastMsgDateStr = lastActiveDate[member] || firstActiveDate[member] || minDateStr;

      for (const d of Object.keys(groupedMsgs)) {
        if (groupedMsgs[d][member] && groupedMsgs[d][member].some(m => m.text.includes('퇴사'))) {
          isResigned = true;
          if (d > lastMsgDateStr) lastMsgDateStr = d; 
        }
      }

      if (!isResigned && !isAlreadyResigned) {
        const lastMsgObj = new Date(lastMsgDateStr);
        const diffDays = Math.floor((todayObj - lastMsgObj) / (1000 * 60 * 60 * 24));
        if (diffDays >= 14) {
          isResigned = true;
        }
      }

      if (isResigned || needsLeaveDate) {
        const leaveObj = new Date(lastMsgDateStr);
        leaveObj.setDate(leaveObj.getDate() + 1); 
        const leaveDateStr = `${leaveObj.getFullYear()}-${String(leaveObj.getMonth() + 1).padStart(2, '0')}-${String(leaveObj.getDate()).padStart(2, '0')}`;
        
        emp.status = '퇴사';
        emp.leaveDate = leaveDateStr;

        if (emp.rowIndex) {
          masterUpdates.push({
            range: `'${masterSheetName}'!B${emp.rowIndex}:D${emp.rowIndex}`,
            values: [['퇴사', emp.joinDate, leaveDateStr]]
          });
        }
      }
    }
  }

  if (masterUpdates.length > 0) {
    await sheets.sheets.spreadsheets.values.batchUpdate({ 
      spreadsheetId: sheets.sheetId, 
      requestBody: { valueInputOption: 'USER_ENTERED', data: masterUpdates } 
    });
    console.log(`[안내] 사원마스터 시트에 ${masterUpdates.length}명의 자동 퇴사 처리가 반영되었습니다.`);
  }

  // =========================================================================
  // 1단계: 최근 30일(또는 초기) 슬랙 기반 동기화 루프
  // =========================================================================
  for (const date of allDays) {
    if (!isInitialRun && date < limitDateStr) continue;

    const dObj = new Date(date);
    const yyyy = dObj.getFullYear(); 
    
    if (!sheetData[yyyy]) continue;

    const currentExistingRows = sheetData[yyyy].existingRows;
    const currentSheetName = sheetData[yyyy].sheetName;

    const dayName = DAY_NAMES[dObj.getDay()];
    const holidayName = holidaysMap[date];
    const isWeekend = (dObj.getDay() === 0 || dObj.getDay() === 6);

    for (const member of targetMembers) {
      const emp = masterMap[member];
      const userJoinDate = firstActiveDate[member] || emp.joinDate;
      if (date < userJoinDate) continue;

      const msgs = groupedMsgs[date]?.[member] || [];
      const rowIdx = currentExistingRows.findIndex(r => r[0] === date && r[2] === member); 
      const row = rowIdx >= 0 ? currentExistingRows[rowIdx] : null;

      // 🛑 [여기에 방어벽 추가!] 봇이나 관리자가 수동 정정한 행은 스위퍼가 덮어쓰지 않도록 보호 (Lock)
      if (row && row[12] && (
          row[12].includes('[슬랙수정]') || 
          row[12].includes('[슬랙신규]') || 
          row[12].includes('[관리자정정]')
      )) {
        continue; // 이 줄은 무시하고 다음 사람/날짜로 넘어감
      }

      if (emp.status === '퇴사' || emp.status === '퇴사자') {
        if (emp.leaveDate && date >= emp.leaveDate) {
          if (row) {
            toUpdateByYear[yyyy].push({ range: `'${currentSheetName}'!A${rowIdx + 1}:M${rowIdx + 1}`, values: [Array(13).fill('')] });
            currentExistingRows[rowIdx] = Array(13).fill(''); 
          }
          continue; 
        }
      }

      let rawWorkType = emp.workType;
      let workTypeKey = rawWorkType.includes('고정') ? 'FIXED' : (rawWorkType.includes('유연') ? 'FLEXIBLE' : 'PART_TIME');
      let allText = msgs.map(m => m.text.replace(/\n/g, ' ')).join(' | ');
      let leaveStatus = extractLeaveStatus(allText);

      if (msgs.length === 0) {
        if (!row) {
          if (date === todayStr && currentHour < 23) continue;
          let status = '결근', note = '평일 (미보고)';
          if (holidayName) { status = '휴무'; note = `공휴일(${holidayName})`; }
          else if (isWeekend) { status = '휴무'; note = `주말(${dayName})`; }
          let autoLeaveType = status === '결근' ? getLeaveTypeByTenure(userJoinDate, date) : '-';
          
          const newRow = [date, dayName, member, rawWorkType, status, '-', '-', '-', '-', '-', '0', leaveStatus || autoLeaveType, note];
          toAppendByYear[yyyy].push(newRow); 
          currentExistingRows.push(newRow);
        }
        continue;
      }

      let times = []; 
      let forcedEndMin = null;
      let actualStartMin = null; 

      for (const m of msgs) {
        if (m.isCorrection) {
          forcedEndMin = m.correctionTime;
        } else {
          times.push(...extractTimeFromText(m.text, m.ts, m.isMidnightShift));
          if (actualStartMin === null) {
            const kst = getKstObj(m.ts);
            actualStartMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
          }
        }
      }
      times.sort((a, b) => a - b);
      
      const rawStartMin = times[0];
      let endMin = forcedEndMin !== null ? forcedEndMin : (times.length > 1 ? times[times.length - 1] : null);
      const startMin = snapToNearestHour(rawStartMin);
      const latenessCheckMin = actualStartMin !== null ? actualStartMin : startMin;

      if (!leaveStatus && latenessCheckMin >= 13 * 60 + 30 && latenessCheckMin <= 14 * 60 + 30) {
        leaveStatus = '오전반차';
        allText = '[자동반차판정] ' + allText;
      }

      let status = '출근', note = allText;
      if (holidayName || isWeekend) { status = '휴일근무'; note = `[${holidayName ? holidayName : dayName}] ` + allText; }
      
      const hasClockIn = allText.includes('출근') || allText.includes('입실') || times.length > 0;
      const hasClockOut = allText.includes('퇴근') || allText.includes('퇴실') || forcedEndMin !== null;
      const hasClockInAndOut = (hasClockIn && hasClockOut) || (endMin !== null && endMin - rawStartMin >= 4 * 60);

      if (hasClockInAndOut) {
        if (['오전반차', '오후반차', '반차', '조퇴'].includes(leaveStatus)) status = leaveStatus;
      } else {
        if (['연차', '월차', '반차', '오전반차', '오후반차', '휴가', '조퇴', '결근', '예비군', '민방위'].includes(leaveStatus)) status = leaveStatus;
        else if (!hasClockIn && !hasClockOut) status = '단순메시지';
      }

      if (date === todayStr && currentHour === 23 && currentMinute >= 50 && currentMinute <= 52 && hasClockIn && !hasClockOut && status !== '단순메시지') {
        const slackId = nameToSlackId[member];
        if (slackId) {
          dmQueue.push({ userId: slackId, text: `안녕하세요 ${member}님! 오늘 출근 보고는 확인되었으나 아직 퇴근 보고가 누락된 상태입니다. 야근으로 인해 늦어지셨거나 깜빡하셨다면 근태 채널에 아래 양식으로 수정 메시지를 남겨주세요!\n\n*당일 퇴근 정정 예시:* \`[퇴근정정] 18:30\`\n*새벽 야근 정정 예시(새벽 1시 퇴근 시):* \`[퇴근정정] 25:00\` 또는 \`[퇴근정정] 01:00\`` });
        }
      }

      let autoLeaveType = ['연차', '월차', '반차', '오전반차', '오후반차', '휴가'].includes(status) ? getLeaveTypeByTenure(userJoinDate, date) : '-';
      let analysis = { lateness: '-', overtime: '-', overtimeHours: 0 };
      
      if (!['연차', '월차', '휴가', '결근', '예비군', '민방위', '단순메시지'].includes(status)) {
        if (workTypeKey === 'FIXED') analysis = analyzeFixed(latenessCheckMin, endMin);
        else if (workTypeKey === 'FLEXIBLE') analysis = analyzeFlexible(latenessCheckMin, endMin);
        else analysis = analyzePartTime(latenessCheckMin, endMin);

        if (leaveStatus === '오전반차' || leaveStatus === '반차') {
          if (latenessCheckMin <= 14 * 60 + 10) {
            analysis.lateness = '정상';
          }
        }
      }

      if (!row) {
        const newRow = [
          date, dayName, member, rawWorkType, status, analysis.lateness, 
          formatTimeFromMins(startMin), formatTimeFromMins(actualStartMin !== null ? actualStartMin : startMin), formatTimeFromMins(endMin), 
          analysis.overtime, String(analysis.overtimeHours), leaveStatus || autoLeaveType, note
        ];
        toAppendByYear[yyyy].push(newRow); 
        currentExistingRows.push(newRow);
      } else {
        while (row.length < 13) row.push(''); 
        row[1] = dayName; row[3] = rawWorkType; row[4] = status; row[5] = analysis.lateness;
        row[6] = formatTimeFromMins(startMin); 
        row[7] = formatTimeFromMins(actualStartMin !== null ? actualStartMin : startMin); 
        row[8] = formatTimeFromMins(endMin);
        row[9] = analysis.overtime; row[10] = String(analysis.overtimeHours); row[11] = leaveStatus || autoLeaveType; row[12] = note;
        
        toUpdateByYear[yyyy].push({ range: `'${currentSheetName}'!B${rowIdx + 1}:M${rowIdx + 1}`, values: [row.slice(1, 13)] });
      }
    }
  }

  // =========================================================================
  // 2단계: [새로운 엔진] 모든 연도의 과거 기록 수동 변경 소급 적용 (Full Sweeper)
  // =========================================================================
  if (needsFullReconcile) {
    for (const year of targetYears) {
      const currentExistingRows = sheetData[year].existingRows;
      const currentSheetName = sheetData[year].sheetName;

      for (let i = 1; i < currentExistingRows.length; i++) {
        const row = currentExistingRows[i];

        // 🛑 [여기에 방어벽 추가!]
        if (row[12] && (
            row[12].includes('[슬랙수정]') || 
            row[12].includes('[슬랙신규]') || 
            row[12].includes('[관리자정정]')
        )) {
          continue; // 수동 정정된 과거 데이터 보호
        }
        
        const date = row[0];
        const member = row[2];

        if (!date || !member || (!isInitialRun && date >= limitDateStr)) continue;

        const emp = masterMap[member];
        if (!emp) continue;

        let needsUpdate = false;

        if (emp.status === '퇴사' || emp.status === '퇴사자') {
          if (emp.leaveDate && date >= emp.leaveDate) {
            if (row.some(val => val !== '')) {
              toUpdateByYear[year].push({ range: `'${currentSheetName}'!A${i + 1}:M${i + 1}`, values: [Array(13).fill('')] });
              currentExistingRows[i] = Array(13).fill(''); 
            }
            continue;
          }
        }

        if (row[3] !== emp.workType) {
          row[3] = emp.workType;
          needsUpdate = true;
        }

        const dObj = new Date(date);
        const holidayName = holidaysMap[date];
        const isWeekend = (dObj.getDay() === 0 || dObj.getDay() === 6);
        
        if (row[4] === '결근' && (holidayName || isWeekend)) {
          row[4] = '휴무';
          row[12] = holidayName ? `공휴일(${holidayName})` : `주말(${DAY_NAMES[dObj.getDay()]})`;
          needsUpdate = true;
        } 
        else if (row[4] === '휴무' && !holidayName && !isWeekend && row[12] && (row[12].includes('공휴일') || row[12].includes('주말'))) {
          row[4] = '결근';
          row[12] = '평일 (미보고)';
          needsUpdate = true;
        }

        if (needsUpdate) {
          toUpdateByYear[year].push({ range: `'${currentSheetName}'!B${i + 1}:M${i + 1}`, values: [row.slice(1, 13)] });
        }
      }
    }

    // 🟢 [추가] 풀 스위퍼 처리가 끝난 후 새로운 해시값을 '시스템설정' 시트에 업데이트
    if (hashRowIndex > 0) {
      await sheets.sheets.spreadsheets.values.update({
        spreadsheetId: sheets.sheetId,
        range: `'시스템설정'!B${hashRowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[currentHash]] }
      });
    } else {
      await sheets.sheets.spreadsheets.values.append({
        spreadsheetId: sheets.sheetId,
        range: `'시스템설정'!A:C`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [['MASTER_HASH', currentHash, '사원/캘린더 변경 감지용 해시(건드리지 마세요)']] }
      });
    }
  } // 👈 if (needsFullReconcile) 닫힘

  // =========================================================================
  // 3단계: 구글 시트 일괄 API 요청 (Batch Update & Append)
  // =========================================================================
  for (const year of targetYears) {
    const sName = sheetData[year].sheetName;
    const appends = toAppendByYear[year];
    const updates = toUpdateByYear[year];

    if (appends.length > 0) {
      await sheets.sheets.spreadsheets.values.append({ 
        spreadsheetId: sheets.sheetId, 
        range: `'${sName}'!A:M`, 
        valueInputOption: 'RAW', 
        insertDataOption: 'INSERT_ROWS', 
        requestBody: { values: appends } 
      });
    }
    if (updates.length > 0) {
      await sheets.sheets.spreadsheets.values.batchUpdate({ 
        spreadsheetId: sheets.sheetId, 
        requestBody: { valueInputOption: 'RAW', data: updates } 
      });
    }
    
    if (appends.length > 0 || updates.length > 0) {
      await sheets.sortSheet(sName);
    }
  }

  // ─────────────────── Slack DM 발송 로직 ───────────────────
  if (dmQueue.length > 0) {
    for (const dm of dmQueue) {
      try { 
        await slack.call('chat.postMessage', { channel: dm.userId, text: dm.text }); 
        await new Promise(res => setTimeout(res, 300)); // 기존 코드의 resolve 오류 수정
      } catch (err) {}
    }
  }
  
  console.log(`\n========================================\n  ✅ 출퇴근 기록 엔진 완벽 동기화 완료!\n========================================`);
}

main().catch(err => { console.error('\n❌ 실행 중 오류 발생:', err); process.exit(1); });