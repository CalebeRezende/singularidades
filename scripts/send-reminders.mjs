// Envia lembretes por WhatsApp (via CallMeBot) para eventos da agenda.
// Roda em três modos (ver .github/workflows/agenda-reminders.yml):
//   - "antes": à noite, avisa sobre os eventos (não recorrentes) de amanhã.
//   - "hoje":  de manhã, avisa sobre os eventos (não recorrentes) de hoje.
//   - "exato": a cada ~15min, dispara o lembrete único de eventos recorrentes
//              (ex: remédio) no horário escolhido pelo usuário.

const JSONBIN_BIN_ID = '6a7379b0da38895dfebe0814';
const JSONBIN_API_KEY = '$2a$10$27rhUeaoctLDffTbCTjq7OjFhxqxihlBKPnf5UKFpy1FBs7BrHXW.';
const API_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const MODE = ['hoje', 'exato'].includes(process.env.REMINDER_MODE) ? process.env.REMINDER_MODE : 'antes';

// Janela de tolerância (minutos) pra bater o horário exato do lembrete com
// o horário em que o cron realmente rodou (ele roda a cada 15min e pode atrasar).
const JANELA_EXATO_MIN = 15;

if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) {
  console.error('CALLMEBOT_PHONE e CALLMEBOT_APIKEY precisam estar configurados como secrets do repositório.');
  process.exit(1);
}

function spParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => +parts.find(p => p.type === t).value;
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

function spDateString(daysOffset = 0) {
  const { y, m, d } = spParts();
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + daysOffset * 86400000).toISOString().slice(0, 10);
}

function spNowMinutes() {
  const { hh, mm } = spParts();
  return hh * 60 + mm;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
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

async function sendWhatsapp(text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`Falha ao enviar WhatsApp: ${res.status} - ${body}`);
  console.log('CallMeBot respondeu:', body.slice(0, 200));
}

function isActiveOn(e, dateStr) {
  if (e.repetirAteData) return dateStr >= e.data && dateStr <= e.repetirAteData;
  return e.data === dateStr;
}

// Compatibilidade com eventos antigos que só tinham o campo "lembreteEnviado"
// (equivalente ao lembrete "antes" enviado).
function jaEnviadoBatch(e) {
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

// Eventos recorrentes (repetirAteData) têm lembrete próprio no horário
// escolhido (modo "exato") e por isso não entram nos avisos em lote.
async function runBatch() {
  const targetDate = spDateString(MODE === 'hoje' ? 0 : 1);
  const flagKey = MODE === 'hoje' ? 'lembreteHojeEnviado' : 'lembreteAntesEnviado';
  const events = await fetchEvents();
  const due = events.filter(e => !e.repetirAteData && isActiveOn(e, targetDate) && !jaEnviadoBatch(e));

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

async function runExato() {
  const todayStr = spDateString(0);
  const nowMin = spNowMinutes();
  const events = await fetchEvents();

  const due = events.filter(e => {
    if (!e.horaLembrete || !isActiveOn(e, todayStr)) return false;
    if ((e.diasExatoEnviados || []).includes(todayStr)) return false;
    const alvo = toMinutes(e.horaLembrete);
    return nowMin >= alvo && nowMin < alvo + JANELA_EXATO_MIN;
  });

  if (!due.length) {
    console.log(`[modo exato] Nenhum lembrete pendente agora (${todayStr}).`);
    return;
  }

  for (const e of due) {
    const detalhe = e.hora ? ` (${e.hora})` : '';
    const obs = e.obs ? `\n${e.obs}` : '';
    await sendWhatsapp(`💊 Lembrete: ${e.titulo}${detalhe}${obs}`);
  }

  const dueIds = new Set(due.map(e => e.id));
  const updated = events.map(e => dueIds.has(e.id) ? { ...e, diasExatoEnviados: [...(e.diasExatoEnviados || []), todayStr] } : e);
  await saveEvents(updated);

  console.log(`[modo exato] Lembrete enviado para ${due.length} evento(s) recorrente(s) de ${todayStr}.`);
}

async function main() {
  if (MODE === 'exato') await runExato();
  else await runBatch();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
