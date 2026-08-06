// Envia lembretes por WhatsApp (via CallMeBot) para eventos da agenda.
// Roda em dois horários (ver .github/workflows/agenda-reminders.yml):
//   - modo "antes": à noite, avisa sobre os eventos de amanhã.
//   - modo "hoje":  de manhã, avisa sobre os eventos de hoje.

const JSONBIN_BIN_ID = '6a7379b0da38895dfebe0814';
const JSONBIN_API_KEY = '$2a$10$27rhUeaoctLDffTbCTjq7OjFhxqxihlBKPnf5UKFpy1FBs7BrHXW.';
const API_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const MODE = process.env.REMINDER_MODE === 'hoje' ? 'hoje' : 'antes';

if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) {
  console.error('CALLMEBOT_PHONE e CALLMEBOT_APIKEY precisam estar configurados como secrets do repositório.');
  process.exit(1);
}

function spDateString(daysOffset = 0) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(new Date());
  const y = +parts.find(p => p.type === 'year').value;
  const m = +parts.find(p => p.type === 'month').value;
  const d = +parts.find(p => p.type === 'day').value;
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + daysOffset * 86400000).toISOString().slice(0, 10);
}

async function fetchEvents() {
  const res = await fetch(`${API_BASE}/latest`, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
  if (!res.ok) throw new Error(`Falha ao ler o JSONBin: ${res.status}`);
  const data = await res.json();
  return (data.record && data.record.eventos) ? data.record.eventos : [];
}

async function saveEvents(events) {
  const res = await fetch(API_BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
    body: JSON.stringify({ eventos: events }),
  });
  if (!res.ok) throw new Error(`Falha ao salvar o JSONBin: ${res.status}`);
}

// Compatibilidade com eventos antigos que só tinham o campo "lembreteEnviado"
// (equivalente ao lembrete "antes" enviado).
function jaEnviado(e) {
  if (MODE === 'hoje') return !!e.lembreteHojeEnviado;
  return e.lembreteAntesEnviado !== undefined ? !!e.lembreteAntesEnviado : !!e.lembreteEnviado;
}

function buildMessage(events, dateLabel) {
  const quando = MODE === 'hoje' ? `hoje (${dateLabel})` : `amanhã (${dateLabel})`;
  const linhas = events.map(e => {
    const hora = e.hora ? `${e.hora} - ` : '';
    const obs = e.obs ? `\n  ${e.obs}` : '';
    return `• ${hora}${e.titulo}${obs}`;
  });
  return `🔔 Lembrete: ${quando} você tem:\n\n${linhas.join('\n')}`;
}

async function sendWhatsapp(text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`Falha ao enviar WhatsApp: ${res.status} - ${body}`);
  console.log('CallMeBot respondeu:', body.slice(0, 200));
}

async function main() {
  const targetDate = spDateString(MODE === 'hoje' ? 0 : 1);
  const flagKey = MODE === 'hoje' ? 'lembreteHojeEnviado' : 'lembreteAntesEnviado';
  const events = await fetchEvents();
  const due = events.filter(e => e.data === targetDate && !jaEnviado(e));

  if (!due.length) {
    console.log(`[modo ${MODE}] Nenhum lembrete pendente para ${targetDate}.`);
    return;
  }

  const [y, m, d] = targetDate.split('-');
  const message = buildMessage(due, `${d}/${m}`);
  await sendWhatsapp(message);

  const dueIds = new Set(due.map(e => e.id));
  const updated = events.map(e => dueIds.has(e.id) ? { ...e, [flagKey]: true } : e);
  await saveEvents(updated);

  console.log(`[modo ${MODE}] Lembrete enviado para ${due.length} evento(s) de ${targetDate}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
