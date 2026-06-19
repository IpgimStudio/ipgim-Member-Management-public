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
    attendance: '출퇴근기록',
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

// [신규] 이름에서 괄호와 그 안의 내용(상태 메시지 등)을 깔끔하게 지워주는 함수
function cleanUserName(rawName) {
  if (!rawName) return '알 수 없음';
  // (), [], {}, <> 안에 있는 모든 텍스트와 주변 공백 제거
  return rawName.replace(/\s*[\(\[\{<].*?[\)\]\}>]\s*/g, '').trim();
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
            // 호환성을 위해 'active'도 동일하게 취급, 기본값은 '재직'
            status: rows[i][1] || '재직',
            joinDate: rows[i][2] || '2000-01-01',
            workType: rows[i][5] || '고정' 
          };
        }
      }
      return employees;
    } catch (err) {
      console.warn(`[Sheets] 사원마스터 로드 실패: ${err.message}`);
      return {};
    }
  }

  async addEmployee(name, joinDate) {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `'${CONFIG.sheets.sheetNames.employee}'!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      // 기본 상태를 '재직'으로 한국어화
      requestBody: { values: [[name, '재직', joinDate, '', '자동등록', '고정']] },
    });
  }
}

// ─────────────────── 메시지 정밀 파싱 ───────────────────
function parseAttendanceMessage(msg, today, userMap, masterMap) {
  const text = msg.text?.trim() || '';
  if (!text) return null;

  let type = null;
  if (text.includes('퇴근') || text.includes('퇴사')) type = 'check-out';
  else if (text.includes('출근')) type = 'check-in';
  else return null;

  let status = '정상';
  if (text.includes('반차')) status = '반차';
  else if (text.includes('연차')) status = '연차';
  else if (text.includes('휴가') || text.includes('명절') || text.includes('추석')) status = '휴가';
  else if (text.includes('결근')) status = '결근';
  else if (text.includes('지각')) status = '지각';
  else if (text.includes('조퇴')) status = '조퇴';
  else if (text.includes('퇴사')) status = '퇴사';

  // [중요] 이름에 괄호로 붙어있는 연월차 정보 제거 (예: 양나영(6/25오후반차) -> 양나영)
  const rawName = userMap[msg.user] || msg.user || '알 수 없음';
  const userName = cleanUserName(rawName);
  
  let workType = masterMap[userName]?.workType || '고정';
  if (text.includes('유연')) workType = '유연';
  if (text.includes('재택')) workType = '재택';

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

  const cleanNote = text.replace(/\n/g, ' ');

  return {
    slackTs: msg.ts,
    timestamp: parseFloat(msg.ts),
    date: today,
    name: userName, // 정제된 이름 사용
    type: type,
    workType: workType,
    status: status,
    overtime: overtime,
    overtimeMins: overtimeMins,
    note: cleanNote
  };
}

// ─────────────────── 메인 로직 ───────────────────
async function main() {
  console.log('========================================');
  console.log('  Slack 출퇴근 스마트 로거 v9.0 실행');
  console.log('========================================\n');

  const sheets = new SheetsClient();
  const sheetName = CONFIG.sheets.sheetNames.attendance;
  const masterSheetName = CONFIG.sheets.sheetNames.employee;
  
  await sheets.ensureSheet(sheetName, ['날짜', '이름', '출근시간', '퇴근시간', '근무유형', '상태', '연장', '연장시간(분)', '비고', 'slack_ts', '출처']);
  await sheets.ensureSheet(masterSheetName, ['이름', '상태', '입사일', '퇴사일', '비고', '근무제']);
  
  let existingRows = await sheets.readAll(sheetName);
  const lastTs = sheets.getLatestSlackTs(existingRows);
  console.log(`[Sheets] 기준 데이터: ${Math.max(0, existingRows.length - 1)}행 (마지막 TS: ${lastTs ?? '없음'})`);

  const slack = new SlackClient(CONFIG.slack.token);
  const userMap = await slack.getUsers();
  
  const masterMap = await sheets.getEmployeeMaster();
  const toAppend = [];
  const toUpdate = [];

  // 과거 기록 자동 동기화
  let syncCount = 0;
  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i];
    while (row.length < 11) row.push('');

    const name = row[1];
    const currentWorkType = row[4] || '고정';
    const currentStatus = row[5] || '정상';
    const masterWorkType = masterMap[name]?.workType;

    if (masterWorkType && currentWorkType === '고정' && masterWorkType !== '고정') {
      row[4] = masterWorkType; 
      toUpdate.push({ range: `'${sheetName}'!E${i + 1}`, values: [[masterWorkType]] });
      
      if (masterWorkType === '아르바이트' && currentStatus === '확인(반차/조퇴)') {
        row[5] = '정상';
        toUpdate.push({ range: `'${sheetName}'!F${i + 1}`, values: [['정상']] });
      }
      syncCount++;
    }
  }
  if (syncCount > 0) {
    console.log(`\n[마스터 동기화] 과거 기록 ${syncCount}건의 근무제/상태를 자동 수정했습니다.`);
  }

  const oldest = lastTs ? String(parseFloat(lastTs) + 0.000001) : '0';
  console.log(`\n--- Slack 채널 메시지 수집 중... ---`);
  const messages = await slack.fetchMessagesInRange(CONFIG.slack.channelId, oldest);
  console.log(`[Slack] 처리할 새 메시지: ${messages.length}건\n`);

  let parsedCount = 0;

  for (const msg of messages) {
    if (msg.subtype && msg.subtype !== 'message_changed') continue; 
    
    const dateStr = getDateFromTs(msg.ts);
    const parsed = parseAttendanceMessage(msg, dateStr, userMap, masterMap);
    
    if (!parsed) continue;

    if (!masterMap[parsed.name]) {
      console.log(`  [신규 등록] ${parsed.name} 사원마스터에 추가 중...`);
      await sheets.addEmployee(parsed.name, dateStr);
      // 신규 추가 시 상태는 '재직'으로 메모리에도 반영
      masterMap[parsed.name] = { status: '재직', joinDate: dateStr, workType: '고정' };
      parsed.workType = '고정'; 
    }

    parsedCount++;
    const timeStr = formatTimeDisplay(parsed.timestamp);
    const typeMark = parsed.type === 'check-in' ? '▶ 출근' : '◀ 퇴근';
    
    console.log(`  [${parsed.date} ${timeStr}] ${parsed.name.padEnd(5)} ${typeMark} | 상태:${parsed.status} | 유형:${parsed.workType}`);

    if (parsed.type === 'check-in') {
      const newRow = [
        parsed.date, parsed.name, timeStr, '', parsed.workType, parsed.status, parsed.overtime, parsed.overtimeMins, parsed.note, parsed.slackTs, 'slack-logger'
      ];
      toAppend.push(newRow);
      existingRows.push([...newRow]);
    } 
    else if (parsed.type === 'check-out') {
      let targetRowIdx = -1;
      for (let i = existingRows.length - 1; i >= 1; i--) {
        const row = existingRows[i];
        if (row[0] === parsed.date && row[1] === parsed.name) {
          targetRowIdx = i;
          break;
        }
      }

      if (targetRowIdx !== -1) {
        const row = existingRows[targetRowIdx];
        row[3] = timeStr; 
        
        if (row[9]) {
          const checkinTs = parseFloat(row[9]);
          const checkoutTs = parsed.timestamp;
          const durationHours = (checkoutTs - checkinTs) / 3600;
          
          if (parsed.workType !== '아르바이트' && durationHours > 0 && durationHours < 6 && parsed.status === '정상') {
            row[5] = '확인(반차/조퇴)';
          } else if (parsed.status !== '정상') {
            row[5] = parsed.status;
          }
        } else {
          if (parsed.status !== '정상') row[5] = parsed.status;
        }
        
        row[9] = parsed.slackTs;
        if (parsed.workType !== '고정') row[4] = parsed.workType;
        if (parsed.overtime === 'O') {
          row[6] = 'O'; row[7] = parsed.overtimeMins;
        }
        const oldNote = row[8] || '';
        row[8] = oldNote ? `${oldNote} | ${parsed.note}` : parsed.note;

        toUpdate.push({ range: `'${sheetName}'!D${targetRowIdx + 1}`, values: [[row[3]]] });
        toUpdate.push({ range: `'${sheetName}'!E${targetRowIdx + 1}`, values: [[row[4]]] });
        toUpdate.push({ range: `'${sheetName}'!F${targetRowIdx + 1}`, values: [[row[5]]] });
        toUpdate.push({ range: `'${sheetName}'!G${targetRowIdx + 1}`, values: [[row[6]]] });
        toUpdate.push({ range: `'${sheetName}'!H${targetRowIdx + 1}`, values: [[row[7]]] });
        toUpdate.push({ range: `'${sheetName}'!I${targetRowIdx + 1}`, values: [[row[8]]] });
        toUpdate.push({ range: `'${sheetName}'!J${targetRowIdx + 1}`, values: [[row[9]]] });
      } else {
        const newRow = [
          parsed.date, parsed.name, '', timeStr, parsed.workType, parsed.status, parsed.overtime, parsed.overtimeMins, parsed.note, parsed.slackTs, 'slack-logger'
        ];
        toAppend.push(newRow);
        existingRows.push([...newRow]);
      }
    }
  }

  console.log(`\n--- 날짜 전체(주말 포함) 미보고자 마감 검사 실행 ---`);
  
  const todayStr = getDateFromTs(Date.now() / 1000);
  // '재직'이거나 레거시 'active'인 사람 모두 포함
  const activeMembers = Object.keys(masterMap).filter(n => masterMap[n].status === '재직' || masterMap[n].status === 'active');
  
  let dateSet = new Set(messages.map(m => getDateFromTs(m.ts)));
  if (dateSet.size === 0) dateSet.add(todayStr);
  
  const sortedDates = Array.from(dateSet).sort();
  const minDateObj = new Date(sortedDates[0]);
  const todayObj = new Date(todayStr);

  const allDays = [];
  for (let d = new Date(minDateObj); d <= todayObj; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    allDays.push(`${y}-${m}-${day}`);
  }

  let missingCount = 0;
  for (const targetDate of allDays) {
    const todayRecords = existingRows.filter(r => r[0] === targetDate);
    const reportedNames = new Set(todayRecords.map(r => r[1]));

    for (const member of activeMembers) {
      if (targetDate < masterMap[member].joinDate) continue;

      if (!reportedNames.has(member)) {
        const newRow = [
          targetDate, member, '', '', masterMap[member].workType, '확인(연차/결근)', '', '', '미보고 (자동생성)', '', 'slack-logger'
        ];
        toAppend.push(newRow);
        existingRows.push([...newRow]);
        reportedNames.add(member);
        missingCount++;
      }
    }
  }

  if (missingCount > 0) {
    console.log(`  [결과] 총 ${missingCount}건의 미보고(주말/평일 포함) 누락 데이터를 추가했습니다.`);
  } else {
    console.log(`  [결과] 누락된 보고 내역이 없습니다.`);
  }

  // 3. 일괄 반영
  if (toAppend.length > 0) {
    await sheets.sheets.spreadsheets.values.append({
      spreadsheetId: sheets.sheetId, 
      range: `'${sheetName}'!A:K`,
      valueInputOption: 'USER_ENTERED', 
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend },
    });
  }

  if (toUpdate.length > 0) {
    await sheets.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheets.sheetId, 
      requestBody: { valueInputOption: 'USER_ENTERED', data: toUpdate }
    });
  }

  console.log(`\n========================================`);
  console.log(`  ✅ 전체 처리 완료 (동기화: ${syncCount} / 파싱: ${parsedCount} / 미보고: ${missingCount})`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('\n❌ 실행 중 오류 발생:', err);
  process.exit(1);
});