# 🎲 Squad Roulette — Discord Bot

**Squad Roulette** is a Discord bot that automates weekly squad leadership rotations for gaming communities.  
Each week, members can sign up, three random squad leaders are selected, and everyone votes for the *Squadlead of the Week*.  
Points are tracked automatically — collect 3 to earn the **Squadleader** role, but stay active to keep it!

---

## 🚀 Features

- 🗓️ **Fully Automated Weekly Cycle**
  - Friday → Signup post in `#squad-roulette`
  - Monday → 3 Squadleaders are randomly chosen
  - Sunday → Community voting reminder + buttons
  - Monday (next week) → Results announced + points awarded

- 🏆 **Points & Roles**
  - 1 SL point per weekly win  
  - 3 SL points → automatic Squadleader role  
  - Role is removed after inactivity (configurable)

- ⚙️ **Slash Commands**
  | Command | Description |
  |----------|-------------|
  | `/punkte` | Shows your current SL points |
  | `/leaderboard` | Displays top Squadleaders |
  | `/anmeldungen` | Shows all current signups |
  | `/votestand` | Shows current votes |
  | `/force job:<type>` | Admin-only: manually trigger signup, pick, reminder, close, or cleanup |

- 💾 **Persistent Storage**
  - SQLite (`roulette.db`) for all signups, votes, and SL points

- 🧠 **Cron-based Automation**
  - All scheduling is controlled via `.env` using CRON syntax

---

## 🧩 Installation

### 1️⃣ Clone the Repository

```
git clone https://github.com/shignet/squad-roulette.git
cd squad-roulette
```

### 2️⃣ Install Dependencies
```
npm install
```

### 3️⃣ Create and Fill .env
- Create a `.env` file in your project root with the following content:
```
DISCORD_TOKEN=YOUR_BOT_TOKEN
GUILD_ID=123456789012345678
CHANNEL_ID=123456789012345678            # ID of #squad-roulette channel
SQUADLEADER_ROLE_ID=123456789012345678   # ID of Squadleader role
TIMEZONE=Europe/Berlin

# Schedule (CRON syntax)
SIGNUP_POST_CRON=0 0 12 * * 5            # Friday 12:00
PICK_LEADERS_CRON=0 0 12 * * 1           # Monday 12:00
VOTE_REMINDER_CRON=0 0 18 * * 0          # Sunday 18:00
CLOSE_VOTE_CRON=0 0 10 * * 1             # Monday 10:00
INACTIVITY_WEEKS=4                       # Remove role after N inactive weeks

```

### ▶️ Running the Bot
- Start locally
```
node index.js
```
- Optional: Run as a service (Linux)

- Create a file:
`/etc/systemd/system/squad-roulette.service`
```
Unit]
Description=Discord Squad-Roulette Bot
After=network.target

[Service]
WorkingDirectory=/opt/discord-bots/squad-roulette
ExecStart=/usr/bin/node index.js
Restart=always
User=discordbot
EnvironmentFile=/opt/discord-bots/squad-roulette/.env

[Install]
WantedBy=multi-user.target
```
- Then enable and start it:
```
sudo systemctl daemon-reload
sudo systemctl enable squad-roulette.service
sudo systemctl start squad-roulette.service
```
- Check logs:
`journalctl -u squad-roulette.service -f`

---
### 🧹 Maintenance
#### Reset Database

If you want to start clean (delete all data):
`rm -f roulette.db roulette.db-shm roulette.db-wal`

---
### 🔐 Permissions Required

When generating the bot’s invite URL, include:

- Scopes
  - bot
  - applications.commands

- Bot Permissions
  - View Channels
  - Send Messages
  - Manage Roles
  - Embed Links
  - Read Message History
  - Use Slash Commands
---
### 🧾 License

  - MIT License © 2025 [Shignet]
  - You’re free to use, modify, and share — just credit the original creator.
---
### 💬 Credits

Developed by Shignet
