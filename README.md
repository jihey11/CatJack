# CatJack

고양이 테마의 2~4인 실시간 멀티플레이 블랙잭 웹게임입니다.

- Frontend: HTML / CSS / JavaScript
- Backend: Node.js / Express
- Real-time: Socket.IO
- Database: MongoDB Atlas
- Multi-instance sync: Socket.IO MongoDB Adapter
- Card data: Deck of Cards API
- Authentication: JWT + bcryptjs
- Deployment target: Vercel

## 구현된 기능

- 회원가입 / 로그인
- 신규 회원 1,000 CHIP 지급
- 공개 게임방 생성
- 방 코드 참가
- 빠른 참가
- 2~4인 실시간 게임
- READY / 배팅
- 서버에서 턴 관리
- HIT / STAND
- 딜러 자동 진행(17 이상 STAND)
- Ace 1/11 자동 계산
- Blackjack / WIN / LOSE / DRAW 판정
- 게임 결과에 따른 가상 CHIP 정산
- Deck of Cards API 카드 값을 고양이 UI로 변환
- 실시간 방 채팅
- CHIP 랭킹
- 최근 게임 기록
- 게임 결과 MongoDB 저장
- 게임방 상태 MongoDB 저장
- Vercel 여러 인스턴스 사이의 Socket.IO 이벤트 동기화
- 연결이 잠시 끊겨도 같은 방 재접속 시도

> 실제 돈을 사용하지 않는 게임 내부 가상 CHIP만 사용합니다.

---

## 1. 준비물

1. Node.js 20
2. MongoDB Atlas 계정
3. GitHub 계정
4. Vercel 계정
5. 인터넷 연결

---

## 2. MongoDB Atlas 준비

MongoDB Atlas에서 Cluster를 만든 뒤 Database Access에서 사용자를 생성합니다.

연결 문자열 예시:

```text
mongodb+srv://아이디:비밀번호@클러스터주소/catjack?retryWrites=true&w=majority
```

이 프로젝트는 Socket.IO의 여러 서버 인스턴스를 동기화하기 위해 MongoDB Change Stream을 사용하는 `@socket.io/mongo-adapter`도 사용합니다. MongoDB Atlas는 replica set 기반이므로 이 용도에 적합합니다.

Vercel Marketplace에서 MongoDB Atlas를 연결하는 방법도 사용할 수 있으며, 이 경우 `MONGODB_URI` 환경 변수를 Vercel 프로젝트에 연결할 수 있습니다.

---

## 3. 로컬 환경변수

프로젝트 최상위 폴더에서 `.env.example`을 복사해 `.env`를 만듭니다.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

`.env`:

```env
PORT=3000
MONGODB_URI=mongodb+srv://YOUR_ID:YOUR_PASSWORD@YOUR_CLUSTER/catjack?retryWrites=true&w=majority
JWT_SECRET=아주_길고_랜덤한_문자열
```

`.env`는 GitHub에 업로드하지 않습니다. `.gitignore`에 등록되어 있습니다.

---

## 4. 로컬 실행

패키지 설치:

```bash
npm install
```

실행:

```bash
npm start
```

브라우저:

```text
http://localhost:3000
```

코드 구문 검사:

```bash
npm run check
```

---

## 5. 멀티플레이 테스트

서로 다른 로그인 세션이 필요합니다.

예:

- Chrome 일반 창 + Chrome 시크릿 창
- Chrome + Edge
- 서로 다른 PC

테스트 순서:

1. 사용자 A 회원가입 / 로그인
2. 사용자 B 회원가입 / 로그인
3. 사용자 A가 방 생성
4. 방 코드 확인
5. 사용자 B가 방 코드로 참가
6. 각자 배팅 설정
7. 모두 READY
8. 방장이 게임 시작
9. 자신의 차례에 HIT 또는 STAND
10. 딜러 진행 후 결과 확인
11. MongoDB의 `games`, `users`, `rooms` Collection 확인

---

# Vercel 배포

## 6. GitHub에 업로드

프로젝트 폴더에서:

```bash
git init
git add .
git commit -m "Initial CatJack"
git branch -M main
git remote add origin https://github.com/내아이디/CatJack.git
git push -u origin main
```

이미 GitHub 저장소를 만들었다면 해당 저장소 주소를 사용합니다.

`.env` 파일은 절대로 GitHub에 올리지 않습니다.

---

## 7. Vercel 프로젝트 생성

1. Vercel에 로그인
2. **Add New → Project**
3. CatJack GitHub 저장소 선택
4. Import
5. Framework Preset은 자동 감지를 우선 사용
6. Root Directory는 `package.json`이 있는 CatJack 프로젝트 폴더로 지정

이 프로젝트는 Express 서버를 사용하며 Vercel에서 Fluid Compute를 사용하도록 `vercel.json`에 다음 설정이 포함되어 있습니다.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "fluid": true
}
```

---

## 8. Vercel 환경변수 설정

Vercel 프로젝트에서:

```text
Settings
→ Environment Variables
```

다음 두 값을 추가합니다.

### MONGODB_URI

```text
mongodb+srv://아이디:비밀번호@클러스터주소/catjack?retryWrites=true&w=majority
```

### JWT_SECRET

예:

```text
catjack-여기에-충분히-길고-랜덤한-문자열
```

`PORT`는 Vercel에서 직접 지정하지 않아도 됩니다.

환경변수를 추가하거나 수정한 뒤에는 반드시 다시 Deploy해야 합니다.

---

## 9. MongoDB Atlas Network Access

Vercel의 실행 서버는 고정된 한 개의 IP만 사용하는 구조가 아닐 수 있으므로 Atlas에서 연결 가능한 네트워크 설정이 필요합니다.

개인 포트폴리오 테스트 단계에서는 Atlas Network Access 설정을 확인하고, Vercel에서 접근할 수 있도록 구성해야 합니다.

접근 범위를 넓게 허용하는 경우에는 반드시 다음을 지킵니다.

- 강한 MongoDB 사용자 비밀번호 사용
- `MONGODB_URI`를 Vercel Environment Variables에만 저장
- GitHub에 `.env` 업로드 금지
- Database Access 권한을 필요한 DB로 제한

Vercel Marketplace의 MongoDB Atlas 연동을 사용하는 방법도 권장합니다.

---

## 10. Vercel 배포

GitHub 연동 방식에서는 main 브랜치에 push하면 자동 배포할 수 있습니다.

CLI로 배포하려면:

```bash
npm install -g vercel
vercel
```

Production 배포:

```bash
vercel --prod
```

배포 후 Vercel에서 제공하는 주소로 접속합니다.

예:

```text
https://catjack.vercel.app
```

실제 주소는 프로젝트 이름에 따라 달라집니다.

---

## 11. Vercel 실시간 통신 구조

CatJack의 배포 구조는 다음과 같습니다.

```text
사용자 A ─┐
사용자 B ─┼─ WebSocket / Socket.IO
사용자 C ─┘
           ↓
      Vercel Express
           ↓
 ┌─────────┴─────────┐
 ↓                   ↓
MongoDB Atlas     Deck of Cards API
 │
 ├─ users
 ├─ games
 ├─ rooms
 └─ socket_io_events
```

`rooms` Collection에는 실제 게임방 상태를 저장합니다.

`socket_io_events` Collection은 Socket.IO MongoDB Adapter가 Vercel의 여러 서버 인스턴스 사이에서 이벤트를 전달하기 위해 사용합니다. 오래된 이벤트 문서는 TTL Index를 이용해 자동 정리하도록 구성되어 있습니다.

---

## 12. Vercel에서 서버 메모리만 사용하지 않는 이유

다음과 같이 게임방을 메모리에만 저장하면:

```javascript
const rooms = new Map();
```

서버 인스턴스가 여러 개 생성될 때 서로 다른 인스턴스가 같은 게임방 정보를 공유할 수 없습니다.

따라서 Vercel 배포 버전에서는 다음처럼 역할을 나눕니다.

```text
MongoDB rooms
→ 게임방 상태 저장

MongoDB Socket.IO Adapter
→ 여러 서버 인스턴스의 실시간 이벤트 전달

Vercel
→ HTML/CSS/JS + Express + Socket.IO 실행
```

---

## 13. 재접속 처리

Socket.IO 클라이언트는 연결이 끊기면 자동 재연결을 시도합니다.

CatJack은 현재 참가 중인 방 코드를 `sessionStorage`에 저장하고 있기 때문에 재연결되면 같은 게임방에 다시 참가하도록 시도합니다.

서버도 네트워크가 잠깐 끊겼다고 즉시 플레이어를 제거하지 않고 짧은 재접속 유예 시간을 둡니다.

---

## 14. 파일 구조

```text
catjack/
├─ public/
│  ├─ index.html
│  ├─ style.css
│  └─ script.js
│
├─ src/
│  ├─ auth.js
│  └─ db.js
│
├─ server.js
├─ package.json
├─ vercel.json
├─ .env.example
├─ .gitignore
└─ README.md
```

---

## 15. MongoDB Collection

### users

회원 계정, 닉네임, CHIP, 게임 통계를 저장합니다.

### games

완료된 게임의 딜러 카드, 사용자 카드, 점수, 배팅, 결과, CHIP 변동을 저장합니다.

### rooms

현재 게임방의 상태를 저장합니다.

예:

```text
방 코드
방 이름
방장
플레이어 목록
READY 상태
배팅
현재 턴
플레이어 카드
딜러 카드
게임 상태
채팅
```

### socket_io_events

Socket.IO 서버 인스턴스 사이의 이벤트 동기화에 사용합니다.

직접 수정할 필요는 없습니다.

---

## 16. 고양이 표시 방식

Deck of Cards API에서 카드 이미지를 화면에 그대로 표시하지 않습니다.

예를 들어 API가 다음 값을 반환하면:

```json
{
  "value": "KING",
  "suit": "HEARTS",
  "code": "KH"
}
```

CatJack에서는 다음과 같이 변환합니다.

```text
KING → 왕관 고양이
HEARTS → 하트 장식
점수 → 10
```

즉, Deck of Cards API는 카드 데이터 생성용이고 실제 화면은 고양이 테마로 구성됩니다.

---

## 17. 보안

- MongoDB 연결 문자열을 `public/script.js`에 넣지 않음
- 비밀번호 원문을 DB에 저장하지 않음
- bcrypt Hash 사용
- JWT 비밀키를 환경변수로 관리
- CHIP 계산을 서버에서 처리
- 카드 뽑기와 승패 판정을 서버에서 처리
- `.env` GitHub 업로드 금지

---

## 18. 배포 후 테스트 순서

1. Vercel 사이트 접속
2. 회원가입
3. 로그인
4. 방 생성
5. 다른 브라우저/PC에서 다른 계정 로그인
6. 방 코드 참가
7. READY
8. 게임 시작
9. HIT / STAND 실시간 동기화 확인
10. 채팅 확인
11. 게임 종료 후 CHIP 확인
12. 새로고침 후 로그인/방 재접속 확인
13. MongoDB `games` 기록 확인
14. Vercel Functions 로그에서 오류 확인

