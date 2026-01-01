# Nado Grid Bot

Nado DEX에서 그리드 MM(Market Making) 전략을 실행하는 자동화 봇입니다.

## 기능

- 📊 **그리드 주문**: ATR 기반 동적 스프레드 조정
- 🔄 **인벤토리 관리**: 자동 포지션 스큐(Skew)
- 🚨 **서킷 브레이커**: 5% 손실 시 자동 중지 (30분)
- 📱 **텔레그램 제어**: 실시간 알림 및 명령어
- 🔀 **델타 헷징**: Hyperliquid 연동 (선택)

## 요구사항

- Node.js v18+ 
- npm 또는 yarn

## 설치

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.example .env
# .env 파일을 편집하여 Private Key와 Telegram 설정 입력

# 3. 실행
npm start
```

## 환경 변수

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `NADO_PRIVATE_KEY` | Nado 지갑 Private Key | ✅ |
| `HYENA_PRIVATE_KEY` | Hyperliquid Private Key | ✅ |
| `IS_TESTNET` | 테스트넷 사용 여부 (`true`/`false`) | ✅ |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | ❌ |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID | ❌ |

## PM2로 백그라운드 실행

```bash
# PM2 설치 (최초 1회)
npm install -g pm2

# 봇 시작
pm2 start npm --name "nado-bot" -- start

# 로그 확인
pm2 logs nado-bot

# 상태 확인
pm2 status

# 재시작
pm2 restart nado-bot

# 중지
pm2 stop nado-bot
```

## 텔레그램 명령어

| 명령어 | 약어 | 설명 |
| --- | --- | --- |
| `/status` | `/s` | 봇 상태 확인 |
| `/balance` | `/b` | 잔고 조회 |
| `/volume` | `/v` | 거래량 조회 |
| `/health` | `/h` | 헬스 체크 |
| `/pnl` | `/p` | 손익 조회 |
| `/stop` | - | 봇 중지 |
| `/start` | - | 봇 재개 |
| `/help` | `/?` | 도움말 |

## 설정 (config.ts)

주요 설정은 `src/config.ts`에서 수정할 수 있습니다:

- `ORDER_SIZE_USD`: 주문 크기
- `MAX_POSITION_USD`: 최대 포지션
- `LONG_SPREADS` / `SHORT_SPREADS`: 그리드 스프레드
- `INVENTORY_SKEW_MULTIPLIER`: 인벤토리 스큐 강도
- `ENABLE_HEDGING`: 헷징 활성화 여부

## 주의사항

⚠️ **Private Key를 절대로 공유하지 마세요!**  
⚠️ **실거래 전 테스트넷에서 충분히 테스트하세요.**

## 라이선스

ISC
