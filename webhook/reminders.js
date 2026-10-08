// Lembretes de horário exato (ex: remédio), disparados pelo Cron Trigger
// do Cloudflare Worker — muito mais pontual que o schedule do GitHub Actions.

const JANELA_MIN = 10; // cron roda a cada 5min; janela cobre 2 tentativas

function spParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => +parts.find(p => p.type === t).value;
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

function spDateString() {
  const { y, m, d } = spParts();
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function spNowMinutes() {
  const { hh, mm } = spParts();
  return hh * 60 + mm;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isActiveOn(e, dateStr) {
  if (e.repetirAteData) return dateStr >= e.data && dateStr <= e.repetirAteData;
  return e.data === dateStr;
}

async function fetchEventos(binId, apiKey) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers: { 'X-Master-Key': apiKey } });
  if (!res.ok) throw new Error(`Falha ao ler JSONBin ${binId}: ${res.status}`);
  const data = await res.json();
  return (data.record && data.record.eventos) ? data.record.eventos : [];
}

async function saveEventos(binId, apiKey, eventos) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
    body: JSON.stringify({ eventos }),
  });
  if (!res.ok) throw new Error(`Falha ao salvar JSONBin ${binId}: ${res.status}`);
}

async function sendWhatsapp(phone, apikey, text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`Falha ao enviar WhatsApp: ${res.status} - ${body}`);
  // CallMeBot às vezes responde 200 mesmo sem entregar de verdade (bot pausado,
  // número não autorizado etc). Só considera sucesso se o corpo confirmar o envio.
  if (!/queued|sent/i.test(body)) {
    throw new Error(`CallMeBot não confirmou o envio: ${body.slice(0, 200)}`);
  }
  return body;
}

export async function runExatoParaAgenda({ nome, binId, apiKey, phone, apikey }) {
  if (!phone || !apikey) {
    console.log(`[${nome}] CallMeBot não configurado (secrets ausentes), pulando.`);
    return;
  }

  const todayStr = spDateString();
  const nowMin = spNowMinutes();
  const eventos = await fetchEventos(binId, apiKey);

  const due = eventos.filter(e => {
    if (!e.horaLembrete || !isActiveOn(e, todayStr)) return false;
    if ((e.diasExatoEnviados || []).includes(todayStr)) return false;
    const alvo = toMinutes(e.horaLembrete);
    return nowMin >= alvo && nowMin < alvo + JANELA_MIN;
  });

  if (!due.length) {
    console.log(`[${nome}] Nenhum lembrete pendente agora (${todayStr}).`);
    return;
  }

  for (const e of due) {
    const detalhe = e.hora ? ` (${e.hora})` : '';
    const obs = e.obs ? `\n${e.obs}` : '';
    await sendWhatsapp(phone, apikey, `💊 Lembrete: ${e.titulo}${detalhe}${obs}`);
  }

  const dueIds = new Set(due.map(e => e.id));
  const updated = eventos.map(e => dueIds.has(e.id) ? { ...e, diasExatoEnviados: [...(e.diasExatoEnviados || []), todayStr] } : e);
  await saveEventos(binId, apiKey, updated);

  console.log(`[${nome}] Lembrete enviado para ${due.length} evento(s) de ${todayStr}.`);
}
