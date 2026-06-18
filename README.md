# Slack 출퇴근 로거

> **ipgim-Member-Management** 프로젝트의 Slack 출퇴근 기록 수집기  
> GitHub Actions에서 주기적으로 실행되어 Slack `#출퇴근` 채널의 메시지를 수집 → 파싱 → Google Sheets에 기록합니다.

---

## 개요

**완전히 독립된 프로그램**으로, GitHub Actions에서 5~10분 간격으로 실행되어 Slack `#출퇴근` 채널의 출퇴근 메시지를 **수집 → 파싱 → Google Sheets에 기록**합니다.

`ipgim-Member-Management`(프라이빗 풀스택 서버)와 **동일한 Google Sheets**를 공유합니다.  
이 로거는 **수집 전용**이며, 연장/연장시간 계산이나 근무제 변경 등은 서버에서 담당합니다.

| 항목 | 담당 |
|------|------|
| Slack 메시지 수집 + 파싱 | ✅ 이 레포 (slack-logger) |
| Google Sheets 기록 | ✅ 이 레포 |
| 연장/연장시간 계산 | 서버 (ipgim-Member-Management) |
| 근무제 변경 / 사원 관리 | 서버 (ipgim-Member-Management) |
| 대시보드 UI | 서버 (ipgim-Member-Management) |

---

## 파일 구조

```
slack-attendance-logger/
├── package.json                   # 의존성 (googleapis, node-fetch)
├── src/
│   └── index.js                   # 메인 로직 (Slack 수집 + 파싱 + Sheets 저장)
├── README.md                      # 이 파일
└── .github/
    └── workflows/
        └── slack-attendance.yml   # GitHub Actions 워크플로우 (5~10분 간격 cron)
```

---

## 동작 방식

### 수집 흐름

1. Google Sheets `출퇴근기록` 시트의 가장 마지막 `slack_ts`(J열)를 읽음
2. 그 시점 **이후**의 Slack 메시지만 `conversations.history`로 조회 (페이지네이션 자동 처리)
3. 출퇴근 패턴에 매칭되는 메시지 파싱 (이름, 출근/퇴근, 근무유형, 상태, 비고)
4. 중복 검사 후 새로운 레코드만 시트에 **append**
5. 퇴근 메시지는 같은 날짜/이름의 출근 row에 퇴근시간 **update**

### 최초 실행

- 시트가 비어 있으면 **에포크 이후 전체 메시지**를 수집 (최초 1회 풀 스캔)
- 그 다음부터는 마지막 수집 시점 이후만 증분(incremental) 수집

### Google Sheets 시트 구조

**시트명: `출퇴근기록`**

헤더는 **11열**로, 서버(ipgim-Member-Management)의 `sheets-db.js`와 정렬되어 있습니다:

| 날짜 | 이름 | 출근시간 | 퇴근시간 | 근무유형 | 상태 | 연장 | 연장시간(분) | 비고 | slack_ts | 출처 |
|------|------|---------|---------|---------|------|------|------------|------|---------|------|
| 2026-06-18 | 김혜경 | 오전 8:23 | 오후 6:00 | 유연 | 정상 | | | | | slack-logger |
| 2026-06-18 | 정호용 | 오전 8:38 | 오후 7:00 | 유연 | 시간외 | | | 6/18 오후반차 | | slack-logger |
| 2026-06-18 | 이용준 | 오전 11:15 | 오후 6:30 | 유연 | 지각 | | | | | slack-logger |

> **참고:** `연장(G)`, `연장시간(H)` 컬럼은 서버에서 계산하여 채웁니다.  
> `slack_ts(J)`는 중복 방지용 Slack 메시지 타임스탬프입니다.  
> `출처(K)`는 이 로거에서 기록한 행은 `slack-logger`로 표시됩니다.

---

## Slack 메시지 파싱 규칙

### 지원 패턴

| 예시 | 설명 |
|------|------|
| `홍길동 출근` | 기본 출근 |
| `홍길동 퇴근` | 기본 퇴근 |
| `홍길동 출근 유연` | 유연근무 출근 |
| `홍길동 출근 유연(오후반차)` | 유연근무 + 비고 |
| `홍길동 출근 지각` | 지각 출근 |
| `홍길동 퇴근 시간외` | 시간외 퇴근 |

### 메시지 필터링

- 일반 사용자 메시지만 처리 (`bot_message`, `channel_join` 등 제외)
- 한국어 `출근`/`퇴근`/`퇴군` 키워드 인식

---

## GitHub Actions 실행 주기

**출퇴근 시간대별로 간격을 달리**하여 최적화되어 있습니다.
`.github/workflows/slack-attendance.yml`에서 `schedule.cron` 값을 변경하여 조절 가능:

| 시간대 (KST) | 간격 | 이유 |
|-------------|------|------|
| 07:00~08:55 | **5분** | 이른 출근자 캡처 |
| 09:00~09:50 | **10분** | 오전 출근 집중시간 |
| 10:00~17:50 | **10분** | 업무시간 (변동 적음) |
| 18:00~20:55 | **5분** | 퇴근 집중시간 |

---

## GitHub Secrets 설정

레포지토리 → Settings → Secrets and variables → Actions 에 아래 5개를 등록해야 합니다:

| Secret | 설명 |
|--------|------|
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | Slack 출퇴근 채널 ID |
| `GOOGLE_SERVICE_EMAIL` | Google Service Account email |
| `GOOGLE_PRIVATE_KEY` | Google Service Account private key |
| `SHEET_ID` | Google Sheets ID (URL의 `spreadsheets/d/.../edit` 부분) |

### 필요한 Slack Scope

- `channels:history` — 채널 메시지 읽기
- `channels:read` — 채널 정보 조회

**읽기 전용**입니다. 봇이 메시지를 남기거나 이모지를 달지 않습니다.

---

## 로컬 실행

```bash
# config.json 생성 (sample 참고)
cp config.sample.json config.json
nano config.json  # secrets 입력

# 실행
node src/index.js
```

`config.sample.json`:
```json
{
  "slack": {
    "token": "xoxb-your-slack-bot-token",
    "channelId": "C1234567890"
  },
  "sheets": {
    "sheetId": "your-google-sheet-id",
    "serviceEmail": "your-sa@project.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  }
}
```

환경변수가 설정되면 `config.json`보다 우선 적용됩니다 (GitHub Actions용).

---

## 라이선스

본 프로젝트는 **IpgimStudio**의 사내 출퇴근 관리 시스템의 일부입니다.