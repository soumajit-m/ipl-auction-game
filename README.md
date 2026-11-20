---
title: IPL Auction & Season Simulator
emoji: 🏏
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# IPL Auction & Season Simulator (2026)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/soumajit-m/ipl-auction-game)

A full-stack, server-authoritative real-time IPL Mega Auction and Season Simulation game engine. Designed with <0.2ms live multiplayer bidding, specialized neural AI franchise bidding models, and a 20-over ball-by-ball match simulation engine.

---

## ⚡ 1-Click Cloud Deployment (Render)

Click the button below to deploy the unified Next.js + Socket.io server directly to Render:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/soumajit-m/ipl-auction-game)

Render will automatically parse the [`render.yaml`](./render.yaml) blueprint and configure:
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start` (Runs unified `server.ts` process 24/7)

---

## 🌟 Core Engine Features

### 1. Server-Authoritative Real-Time Auction
- High-frequency live bidding synchronized over Socket.io.
- Strict solvency hard-clamp: guarantees every franchise reserves sufficient purse for a legal 18-player squad.
- Single-player ₹26.50 Cr hard ceiling.
- Dynamic bid increment ladder (₹0.20 Cr $\rightarrow$ ₹0.25 Cr $\rightarrow$ ₹0.50 Cr $\rightarrow$ ₹1.00 Cr).

### 2. Neural AI Franchise Bidders
- **Superstar Duelist (CSK, MI, RCB)**: Aggressive star acquisition with sniper-bid tactics.
- **Moneyball Core (KKR, RR, GT)**: Value-driven, role-balance prioritization.
- **Disciplined Pragmatist (SRH, DC, PBKS, LSG)**: Liquidity preservation and opportunistic late-auction strikes.

### 3. Monotonic Dual-XGBoost Match Simulator
- Dual monotonic gradient boosted trees: Over Runs Regressor (Poisson) and Over Wickets Classifier (Logistic).
- Full 20-over ball-by-ball physics calculation taking pitch degradation, match phase (Powerplay, Middle, Death), and batsman-bowler tactical matchups into account.
- Dynamic worm charts, Manhattan run distributions, and phase performance breakdowns.

---

## 🛠️ Tech Stack
- **Frontend**: Next.js 14 (App Router), React 18, Tailwind CSS, Lucide Icons, Recharts
- **Backend & Networking**: Node.js, Next.js Custom Server (`server.ts`), Socket.io
- **Database**: MongoDB Atlas with Mongoose
- **Machine Learning**: Custom Neural Policy Networks & XGBoost Decision Trees
- **Authentication**: JWT Host Session & Nodemailer Gmail OTP

---

## 🔐 Environment Variables

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (Atlas or Local) |
| `JWT_SECRET` | Secret key for Host authentication tokens |
| `HOST_ADMIN_PASS` | Administrator password for host privileges |
| `SMTP_EMAIL` | Gmail address for sending OTP verification codes |
| `SMTP_APP_PASSWORD` | Google 16-character App Password for SMTP relay |
| `DEV_FAST_CLOCK` | Fast-forward countdowns in development (`false` in production) |
| `NODE_ENV` | `production` |

---

## 👨‍💻 Creator Attribution
Crafted with passion for IPL & Cricket by **Soumajit**.
