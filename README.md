# Slack 출퇴근 로거 (slack-attendance-logger)

**완전히 독립된 프로그램**으로, GitHub Actions에서 10분마다 실행되어 Slack `#출퇴근` 채널의 출퇴근 메시지를 **수집 → 파싱 → Google Sheets에 기록**합니다.

> 기존 ipgim-Member-Management 시스템과 **완전히 별개**로 동작합니다. 의존성 없음.

---

## 아키텍처

```
GitHub Actions (10분마다 cron 실행)
       │
       ▼
  Slack Web API ── conversations.history ──▶ 메시지 수집
       │
       ▼
  Message Parser ── 이름/시간/출퇴근유형/메모 파싱
       │
       ▼
  Attendance Engine ── 지각/정상/결근 판정
       │
       ▼
  Google Sheets API ── 출퇴근기록 시트에 append/update
```

### Slack API 사용량 (10분 간격 기준)

| API 메서드 | 호출량 | 등급 | 안전 여부 |
|-----------|--------|------|----------|
| `conversations.history` | 144회/일 (1440÷10) | Tier 3 (50+/min) | ✅ **여유** |
| `channels.info` | 144회/일 | Tier 2 (20+/min) | ✅ **여유** |

> **리서치 결과**: 내부 앱(Internal App) + Pro Plan 조합이므로 2025년 `conversations.history` 1rpm 제한 적용 **대상 아님**. 일반 Tier 3 rate limit 유지.

---

## 사전 준비

### 1. Slack App 생성 (내부 앱)

1. https://api.slack.com/apps → **Create New App** → **From Scratch**
2. 앱명: `출퇴근 로거` / 워크스페이스 선택
3. **Bot Token Scopes** 추가:
   - `channels:history` — 메시지 읽기
   - `channels:read` — 채널 정보 읽기
4. **OAuth & Permissions** → Install to Workspace → **Bot Token (`xoxb-...`)** 복사
5. **Event Subscriptions** → Subscribe to bot events:
   - `message.channels` (선택, 현재는 Polling 방식)
6. Slack `#출퇴근` 채널에 Bot 초대: `/invite @출퇴근 로거`

### 2. Google Service Account 생성

1. https://console.cloud.google.com → 프로젝트 생성
2. **IAM 및 관리자** → **서비스 계정** → 계정 생성
3. 키 → **JSON 키 생성** → 다운로드
4. Google Sheets API → **사용 설정**
5. 시트를 만들고 서비스 계정 이메일을 **편집자로 공유**

### 3. Slack 채널 ID 확인

```bash
# curl로 확인
curl -H "Authorization: Bearer xoxb-..." https://slack.com/api/conversations.list
# 또는 채널 우클릭 → "링크 복사" → C1234567 부분
```

---

## GitHub Secrets 설정

| Secret | 값 |
|--------|-----|
| `SLACK_BOT_TOKEN` | `xoxb-` 로 시작하는 Slack Bot Token |
| `SLACK_CHANNEL_ID` | `#출퇴근` 채널 ID (예: `C1234567`) |
| `GOOGLE_SERVICE_EMAIL` | 서비스 계정 이메일 (예: `xxx@xxx.iam.gserviceaccount.com`) |
| `GOOGLE_PRIVATE_KEY` | 서비스 계정 비공개 키 (JSON의 `private_key` 값) |
| `SHEET_ID` | Google Sheets ID (URL의 `spreadsheets/d/***` 부분) |

### Private Key 주의사항
GitHub Secrets에 넣을 때:
- `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` **형태 그대로**
- 줄바꿈은 `\n` 유지 (코드에서 `replace(/\\n/g, '\n')` 처리)
- 혹은 GitHub CLI로: `gh secret set GOOGLE_PRIVATE_KEY < key.pem`

---

## GitHub Actions 실행 주기

현재 `10분 간격`으로 설정되어 있습니다.
`.github/workflows/slack-attendance.yml`에서 `schedule.cron` 값을 변경하여 조절 가능:

| 주기 | cron 표현식 |
|------|------------|
| 5분 | `*/5 * * * *` |
| 10분 | `*/10 * * * *` |
| 30분 | `*/30 * * * *` |
| 1시간 | `0 * * * *` |

---

## Google Sheets 시트 구조

### 시트 1: `출퇴근기록`

| 날짜 | 이름 | 출근시간 | 퇴근시간 | 근무유형 | 상태 | 비고 |
|------|------|---------|---------|---------|------|------|
| 2026-06-18 | 김혜경 | 오전 8:23 | 오후 6:00 | 유연 | 정상 | |
| 2026-06-18 | 정호용 | 오전 8:38 | 오후 7:00 | 유연 | 시간외 | 6/18 오후반차 |
| 2026-06-18 | 이용준 | 오전 11:15 | 오후 6:30 | 유연 | 지각 | |

### 시트 2: `연월차현황` (향후 확장)

| 이름 | 입사일 | 총연차 | 사용연차 | 잔여연차 | 월차발생 | 사용월차 |
|------|--------|-------|---------|---------|---------|---------|

### 시트 3: `월별통계` (향후 확장)

| 년월 | 이름 | 정상 | 지각 | 결근 | 연차 | 반차 | 특이사항 |
|------|------|------|------|------|------|------|---------|

---

## 상태 판정 기준 (계획서 기반)

| 조건 | 판정 |
|------|------|
| 유연근무, 08:00~11:00 출근 | **정상** |
| 유연근무, 11:00 이후 출근 | **지각** |
| 고정근무, 09:00~09:10 출근 | **정상 (10분 예외)** |
| 고정근무, 09:11 이후 출근 | **지각** |
| 오전 4시 이전 기록 | **야근익일** (전날 심야근무로 간주) |
| "(N월N일연차)" 포함 | **연차 사용** |
| "(N월N일반차)" 포함 | **반차 사용** |
| 당일 출근 기록 2회 미만 | **부분 기록** (정보로만 표시) |

---

## 로컬 실행 (디버깅)

```bash
cd slack-attendance-logger
npm install

export SLACK_BOT_TOKEN=xoxb-...
export SLACK_CHANNEL_ID=C1234567
export GOOGLE_SERVICE_EMAIL=xxx@xxx.iam.gserviceaccount.com
export GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
export SHEET_ID=xxx

node src/index.js
```

---

## 파일 구조

```
slack-attendance-logger/
├── package.json          # 의존성 (googleapis, node-fetch)
├── src/
│   └── index.js          # 메인 로직 (Slack 수집 + 파싱 + Sheets 저장)
├── README.md             # 이 파일
└── .github/
    └── workflows/
        └── slack-attendance.yml  # GitHub Actions 워크플로우
```