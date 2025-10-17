/**
 * Discord Squad-Roulette Bot (Produktiv-Version)
 * ------------------------------------------------------------
 * - Freitag 12:00: Anmeldung öffnen (#squad-roulette)
 * - Montag 12:00: 3 Squadleads ziehen (für Mo–So)
 * - Sonntag 18:00: Voting posten
 * - Montag 10:00: Voting schließen, Punkte vergeben, Rolle ab 3 Punkten
 * - Punkte und Aktivität werden in SQLite gespeichert
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} = require('discord.js');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

// --- Config ---
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const SQUADLEADER_ROLE_ID = process.env.SQUADLEADER_ROLE_ID;
const TZ = process.env.TIMEZONE || 'Europe/Berlin';
const SIGNUP_POST_CRON = process.env.SIGNUP_POST_CRON || '0 0 12 * * 5';   // Freitag 12:00
const PICK_LEADERS_CRON = process.env.PICK_LEADERS_CRON || '0 0 12 * * 1'; // Montag 12:00
const VOTE_REMINDER_CRON = process.env.VOTE_REMINDER_CRON || '0 0 18 * * 0'; // Sonntag 18:00
const CLOSE_VOTE_CRON = process.env.CLOSE_VOTE_CRON || '0 0 10 * * 1';     // Montag 10:00
const INACTIVITY_WEEKS = parseInt(process.env.INACTIVITY_WEEKS || '4', 10);

if (!TOKEN || !GUILD_ID || !CHANNEL_ID || !SQUADLEADER_ROLE_ID) {
  console.error('Bitte setze DISCORD_TOKEN, GUILD_ID, CHANNEL_ID, SQUADLEADER_ROLE_ID in .env');
  process.exit(1);
}

// --- DB ---
const db = new Database('roulette.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  points INTEGER NOT NULL DEFAULT 0,
  last_participation TEXT
);
CREATE TABLE IF NOT EXISTS weeks (
  week_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  signup_message_id TEXT,
  participants TEXT,
  leaders TEXT,
  vote_message_id TEXT,
  votes TEXT
);
`);
// DB-Migration: vote_closed-Flag zum Verhindern doppelter Auswertungen
try {
  db.prepare("ALTER TABLE weeks ADD COLUMN vote_closed INTEGER DEFAULT 0").run();
} catch (_) {
  // Spalte existiert schon -> ignorieren
}
// --- Helpers ---
const now = () => DateTime.now().setZone(TZ);
const mondayOfWeek = dt => dt.set({ weekday: 1 }).startOf('day');
function weekIdFromMonday(monday) {
  const wk = monday.weekNumber;
  const yr = monday.weekYear;
  return `${yr}-W${String(wk).padStart(2, '0')}`;
}

// --- User Management ---
function ensureUser(userId) {
  db.prepare('INSERT OR IGNORE INTO users (user_id, points) VALUES (?, 0)').run(userId);
}
function bumpParticipation(userId) {
  ensureUser(userId);
  db.prepare('UPDATE users SET last_participation = ? WHERE user_id = ?')
    .run(now().toISO(), userId);
}
function addPoint(userId) {
  ensureUser(userId);
  db.prepare('UPDATE users SET points = points + 1 WHERE user_id = ?').run(userId);
}
function getPoints(userId) {
  ensureUser(userId);
  return db.prepare('SELECT points FROM users WHERE user_id = ?').get(userId)?.points || 0;
}

// --- Week Storage ---
function setWeekData(weekId, data) {
  const current = db.prepare('SELECT week_id FROM weeks WHERE week_id = ?').get(weekId);
  if (!current) {
    db.prepare('INSERT INTO weeks (week_id, week_start, participants, leaders, votes) VALUES (?, ?, ?, ?, ?)')
      .run(weekId, data.week_start, JSON.stringify(data.participants || []), JSON.stringify(data.leaders || []), JSON.stringify(data.votes || {}));
  }
  if (data.signup_message_id !== undefined)
    db.prepare('UPDATE weeks SET signup_message_id = ? WHERE week_id = ?').run(data.signup_message_id, weekId);
  if (data.vote_message_id !== undefined)
    db.prepare('UPDATE weeks SET vote_message_id = ? WHERE week_id = ?').run(data.vote_message_id, weekId);
  if (data.participants !== undefined)
    db.prepare('UPDATE weeks SET participants = ? WHERE week_id = ?').run(JSON.stringify(data.participants), weekId);
  if (data.leaders !== undefined)
    db.prepare('UPDATE weeks SET leaders = ? WHERE week_id = ?').run(JSON.stringify(data.leaders), weekId);
  if (data.votes !== undefined)
    db.prepare('UPDATE weeks SET votes = ? WHERE week_id = ?').run(JSON.stringify(data.votes), weekId);
}

function getWeek(weekId) {
  const row = db.prepare('SELECT * FROM weeks WHERE week_id = ?').get(weekId);
  if (!row) return null;
  return {
    ...row,
    participants: row.participants ? JSON.parse(row.participants) : [],
    leaders: row.leaders ? JSON.parse(row.leaders) : [],
    votes: row.votes ? JSON.parse(row.votes) : {},
  };
}

function findMostRecentWeek() {
  const row = db.prepare('SELECT * FROM weeks ORDER BY week_start DESC LIMIT 1').get();
  if (!row) return null;
  return {
    ...row,
    participants: row.participants ? JSON.parse(row.participants) : [],
    leaders: row.leaders ? JSON.parse(row.leaders) : [],
    votes: row.votes ? JSON.parse(row.votes) : {},
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// --- Slash Commands ---
const commands = [
  new SlashCommandBuilder().setName('punkte').setDescription('Zeigt deine aktuellen SL-Punkte an.'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Zeigt die Top-Squadleader (SL-Punkte).'),
  new SlashCommandBuilder()
    .setName('anmeldungen')
    .setDescription('Zeigt alle Anmeldungen für eine Woche')
    .addStringOption(o =>
      o.setName('woche').setDescription('ISO-Woche, z. B. 2025-W42').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('force')
    .setDescription('Admin: führe einen Job sofort aus')
    .addStringOption(o =>
      o.setName('job')
        .setDescription('signup|pick|remind|close|cleanup')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('woche')
        .setDescription('Ziel-Week-ID, z. B. 2025-W43 (optional)')) // <– neu
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands.map(c => c.toJSON()) });
}

client.once('ready', async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  await registerCommands();
  scheduleJobs();
});

// --- Interaction Handler ---
client.on('interactionCreate', async (interaction) => {
  try {
    // --- Slash Commands ---
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'punkte') {
        const pts = getPoints(interaction.user.id);
        return interaction.reply({ content: `Du hast **${pts} SL-Punkt(e)**.`, ephemeral: true });
      }

      if (interaction.commandName === 'leaderboard') {
        const rows = db.prepare('SELECT user_id, points FROM users ORDER BY points DESC, user_id LIMIT 10').all();
        const lines = await Promise.all(rows.map(async (r, i) => {
          const member = await interaction.guild.members.fetch(r.user_id).catch(() => null);
          const name = member ? member.displayName : `<@${r.user_id}>`;
          return `**${i + 1}.** ${name} — ${r.points} Punkt(e)`;
        }));
        return interaction.reply({ content: lines.length ? lines.join('\n') : 'Noch keine Punkte.', ephemeral: true });
      }

      if (interaction.commandName === 'anmeldungen') {
        const weekOpt = interaction.options.getString('woche');
        let w = weekOpt ? getWeek(weekOpt) : findMostRecentWeek();
        if (!w) return interaction.reply({ content: 'Keine Woche gefunden 🤷‍♂️', ephemeral: true });
        const participants = w.participants || [];
        if (!participants.length)
          return interaction.reply({ content: `Für **${w.week_id}** gibt es keine Anmeldungen.`, ephemeral: true });
        const lines = await mentionList(participants);
        return interaction.reply({
          content: `📋 **Anmeldungen für ${w.week_id}**\n` +
            lines.map((s, i) => `**${i + 1}.** ${s}`).join('\n'),
          ephemeral: true,
        });
      }

      if (interaction.commandName === 'force') {
        const job = interaction.options.getString('job', true);
        const weekOpt = interaction.options.getString('woche') || null;

        await interaction.reply({
          content: `Starte Job: **${job}**${weekOpt ? ` für **${weekOpt}**` : ''}`,
          ephemeral: true
        });

        if (job === 'signup') await postSignup();                   // erzeugt immer die nächste Woche
        else if (job === 'pick') await pickLeaders(weekOpt);        // optional weekId
        else if (job === 'remind') await postVoteReminder(weekOpt); // optional weekId
        else if (job === 'close') await closeVoteAndAward(weekOpt); // optional weekId
        else if (job === 'cleanup') await cleanupInactivity();
      }
    }

    // --- Button Interactions ---
    if (interaction.isButton()) {
      const [kind, payload] = interaction.customId.split(':');

      if (kind === 'signup') {
        const dt = now();
        const weekId = payload;
        let w = getWeek(weekId);
        if (!w) setWeekData(weekId, { week_start: dt.toISO(), participants: [] });
        const deadline = DateTime.fromISO(w.week_start).setZone(TZ).set({ hour: 12, minute: 0 });
        if (dt > deadline)
          return interaction.reply({ content: 'Anmeldeschluss ist vorbei.', ephemeral: true });
        const set = new Set(w.participants || []);
        set.add(interaction.user.id);
        setWeekData(weekId, { participants: [...set] });
        bumpParticipation(interaction.user.id);
        return interaction.reply({ content: 'Du bist **angemeldet** ✌️', ephemeral: true });
      }

      if (kind === 'vote') {
        const [weekId, candidateId] = payload.split(',');
        const w = getWeek(weekId);
        if (!w?.leaders?.length)
          return interaction.reply({ content: 'Keine laufende Abstimmung.', ephemeral: true });
        const closeDt = DateTime.fromISO(w.week_start).setZone(TZ).plus({ days: 7, hours: 10 });
        if (now() > closeDt)
          return interaction.reply({ content: 'Die Abstimmung ist bereits geschlossen.', ephemeral: true });
        w.votes[interaction.user.id] = candidateId;
        setWeekData(weekId, { votes: w.votes });
        bumpParticipation(interaction.user.id);
        const member = await interaction.guild.members.fetch(candidateId).catch(() => null);
        return interaction.reply({ content: `Stimme für **${member ? member.displayName : 'Kandidat'}** gezählt.`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error('interaction error', err);
  }
});

// --- Jobs ---
function scheduleJobs() {
  cron.schedule(SIGNUP_POST_CRON, postSignup, { timezone: TZ });
  cron.schedule(PICK_LEADERS_CRON, pickLeaders, { timezone: TZ });
  cron.schedule(VOTE_REMINDER_CRON, postVoteReminder, { timezone: TZ });
  cron.schedule(CLOSE_VOTE_CRON, closeVoteAndAward, { timezone: TZ });
  cron.schedule('0 15 10 * * 1', cleanupInactivity, { timezone: TZ });
}

// --- Core Functions ---
async function postSignup() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const dt = now();
  const nextMonday = mondayOfWeek(dt.plus({ weeks: 1 }));
  const weekId = weekIdFromMonday(nextMonday);
  // Doppel-Post-Schutz: Wenn schon ein Signup für diese Woche existiert, abbrechen
  const existing = getWeek(weekId);
  if (existing?.signup_message_id) {
    console.log(`[signup] Skipping duplicate signup for ${weekId} (messageId=${existing.signup_message_id})`);
    return;
  }
  setWeekData(weekId, { week_start: nextMonday.toISO(), participants: [] });
  const deadline = nextMonday.set({ hour: 12, minute: 0 });

  const embed = new EmbedBuilder()
    .setTitle('🎲 Squad-Roulette – Anmeldung geöffnet')
    .setDescription(
      `Melde dich jetzt für die Woche **${nextMonday.toFormat('dd.MM.')}–${nextMonday.plus({ days: 6 }).toFormat('dd.MM.')}** an!\n\n` +
      `**Anmeldeschluss:** Montag, ${deadline.toFormat('dd.MM. HH:mm')} Uhr\n` +
      `Nach Anmeldeschluss werden **3 Squadleads** zufällig gezogen.`
    )
    .setColor(0x5865F2)
    .setFooter({ text: `Woche ${weekId}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`signup:${weekId}`).setLabel('Anmelden').setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  setWeekData(weekId, { signup_message_id: msg.id });
}


async function pickLeaders(weekIdOverride = null) {
  let weekId, monday, w;

  if (weekIdOverride) {
    weekId = weekIdOverride;
    w = getWeek(weekId) || { participants: [] };
    monday = w.week_start ? DateTime.fromISO(w.week_start).setZone(TZ) : mondayOfWeek(now());
  } else {
    const dt = now();
    monday = mondayOfWeek(dt);
    weekId = weekIdFromMonday(monday);
    w = getWeek(weekId) || { participants: [] };
  }

  if (w.leaders?.length) {
    console.log(`[pick] Leaders already chosen for ${weekId}`);
    return;
  }

  const pool = w.participants || [];
  if (!pool.length) {
    await postToChannel(`⚠️ Keine Anmeldungen für ${weekId}.`);
    return;
  }

  const leaders = shuffle(pool).slice(0, Math.min(3, pool.length));
  setWeekData(weekId, { leaders });
  leaders.forEach(bumpParticipation);

  const names = await mentionList(leaders);
  await postToChannel(
    `🎯 **Squadleads für ${monday.toFormat('dd.MM.')}–${monday.plus({ days: 6 }).toFormat('dd.MM.')}**\n` +
    `${names.join('\n')}\n\nAb Sonntag folgt die Abstimmung 🗳️`
  );
}

async function postVoteReminder(weekIdOverride = null) {
  let weekId, w, monday;

  if (weekIdOverride) {
    weekId = weekIdOverride;
    w = getWeek(weekId);
    monday = w?.week_start ? DateTime.fromISO(w.week_start).setZone(TZ) : mondayOfWeek(now());
  } else {
    const dt = now();
    monday = mondayOfWeek(dt);
    weekId = weekIdFromMonday(monday);
    w = getWeek(weekId);
  }

  if (!w?.leaders?.length) return;

  if (w.vote_message_id) {
    console.log(`[remind] Vote already posted for ${weekId}`);
    return;
  }

  const candidates = w.leaders;
  const names = await mentionList(candidates);

  const embed = new EmbedBuilder()
    .setTitle('🗳️ Abstimmung: Squadlead der Woche')
    .setDescription(
      `Stimme jetzt ab, wer in **Woche ${w.week_id}** der *Squadlead der Woche* war!\n\n` +
      names.map((n, i) => `**${i + 1}.** ${n}`).join('\n')
    )
    .setColor(0x57F287)
    .setFooter({ text: 'Abstimmung offen bis Montag 10:00' });

  const row = new ActionRowBuilder().addComponents(
    ...candidates.map((id, idx) =>
      new ButtonBuilder()
        .setCustomId(`vote:${w.week_id},${id}`)
        .setLabel(`Stimme für ${idx + 1}`)
        .setStyle(ButtonStyle.Primary))
  );

  const channel = await client.channels.fetch(CHANNEL_ID);
  const msg = await channel.send({ embeds: [embed], components: [row] });
  setWeekData(w.week_id, { vote_message_id: msg.id });
}

async function closeVoteAndAward(weekIdOverride = null) {
  let weekId, w;

  if (weekIdOverride) {
    weekId = weekIdOverride;
    w = getWeek(weekId);
  } else {
    const dt = now();
    const lastMonday = mondayOfWeek(dt.minus({ weeks: 1 }));
    weekId = weekIdFromMonday(lastMonday);
    w = getWeek(weekId);
  }

  if (!w?.leaders?.length) return;

  if (w.vote_closed) {
    console.log(`[close] Vote already closed for ${weekId}`);
    return;
  }

  const tally = new Map(w.leaders.map(id => [id, 0]));
  Object.entries(w.votes || {}).forEach(([_, candidate]) => {
    if (tally.has(candidate)) tally.set(candidate, tally.get(candidate) + 1);
  });

  const maxVotes = Math.max(0, ...Array.from(tally.values()));
  const top = Array.from(tally.entries()).filter(([_, v]) => v === maxVotes).map(([id]) => id);
  const winner = top[Math.floor(Math.random() * top.length)];

  addPoint(winner);
  const pts = getPoints(winner);

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(winner).catch(() => null);
  if (member && pts >= 3 && !member.roles.cache.has(SQUADLEADER_ROLE_ID)) {
    await member.roles.add(SQUADLEADER_ROLE_ID).catch(() => null);
  }

  db.prepare('UPDATE weeks SET vote_closed = 1 WHERE week_id = ?').run(weekId);

  const names = await mentionList(w.leaders);
  const winnerName = await mentionList([winner]);
  await postToChannel(`✅ **Abstimmung geschlossen (Woche ${weekId})**\n` +
    names.map((n, i) => `Kandidat ${i + 1}: ${n} — **${tally.get(w.leaders[i]) || 0}** Stimme(n)`).join('\n') +
    `\n\n🥇 **Gewinner:** ${winnerName[0]} (+1 SL-Punkt, jetzt ${pts})`);
}


async function cleanupInactivity() {
  const limit = now().minus({ weeks: INACTIVITY_WEEKS });
  const guild = await client.guilds.fetch(GUILD_ID);
  const role = await guild.roles.fetch(SQUADLEADER_ROLE_ID);
  if (!role) return;

  for (const [id, member] of role.members) {
    const row = db.prepare('SELECT last_participation FROM users WHERE user_id = ?').get(id);
    const last = row?.last_participation ? DateTime.fromISO(row.last_participation).setZone(TZ) : null;
    if (!last || last < limit) {
      await member.roles.remove(SQUADLEADER_ROLE_ID).catch(() => null);
      await postToChannel(`⌛ <@${id}> hat seit **${INACTIVITY_WEEKS}** Wochen nicht am Roulette teilgenommen und verliert die **Squadleader**-Rolle.`);
    }
  }
}

// --- Utilities ---
async function postToChannel(text) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  await channel.send({ content: text });
}

async function mentionList(userIds) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const out = [];
  for (const id of userIds) {
    const member = await guild.members.fetch(id).catch(() => null);
    out.push(member ? `${member} (${member.displayName})` : `<@${id}>`);
  }
  return out;
}

// --- Login ---
client.login(TOKEN);
