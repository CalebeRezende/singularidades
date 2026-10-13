// Lembretes de horário exato (ex: remédio), disparados pelo Cron Trigger
// do Cloudflare Worker — muito mais pontual que o schedule do GitHub Actions.
// Manda por dois canais independentes: WhatsApp (CallMeBot, se configurado)
// e notificação push do app instalado (se houver inscrição). Basta um dos
// dois funcionar pra marcar o lembrete como enviado no dia.

import { sendPushToAll } from './push.js';

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

async function fetchRecord(binId, apiKey) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers: { 'X-Master-Key': apiKey } });
  if (!res.ok) throw new Error(`Falha ao ler JSONBin ${binId}: ${res.status}`);
  const data = await res.json();
  return data.record || {};
}

async function saveRecord(binId, apiKey, record) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
    body: JSON.stringify(record),
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

export async function runExatoParaAgenda({ nome, binId, apiKey, phone, apikey, vapidPublicKey, vapidPrivateKey }) {
  const todayStr = spDateString();
  const nowMin = spNowMinutes();
  const record = await fetchRecord(binId, apiKey);
  const eventos = record.eventos || [];
  let subscriptions = record.pushSubscriptions || [];

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

  const enviados = [];
  for (const e of due) {
    const detalhe = e.hora ? ` (${e.hora})` : '';
    const obs = e.obs ? `\n${e.obs}` : '';
    const texto = `💊 Lembrete: ${e.titulo}${detalhe}${obs}`;
    let sucesso = false;

    if (phone && apikey) {
      try {
        await sendWhatsapp(phone, apikey, texto);
        sucesso = true;
      } catch (err) {
        console.log(`[${nome}] Falha no WhatsApp pra "${e.titulo}":`, err.message);
      }
    }

    if (subscriptions.length && vapidPublicKey && vapidPrivateKey) {
      try {
        const resultado = await sendPushToAll(subscriptions, vapidPublicKey, vapidPrivateKey, {
          title: '💊 Lembrete',
          body: `${e.titulo}${detalhe}${obs}`,
        });
        subscriptions = resultado.subscriptions;
        if (resultado.enviouAlgum) sucesso = true;
      } catch (err) {
        console.log(`[${nome}] Falha no push pra "${e.titulo}":`, err.message);
      }
    }

    if (sucesso) enviados.push(e.id);
  }

  if (!enviados.length) {
    console.log(`[${nome}] Nenhum lembrete conseguiu ser entregue agora (${todayStr}).`);
    return;
  }

  const enviadosSet = new Set(enviados);
  const updatedEventos = eventos.map(e => enviadosSet.has(e.id) ? { ...e, diasExatoEnviados: [...(e.diasExatoEnviados || []), todayStr] } : e);
  await saveRecord(binId, apiKey, { ...record, eventos: updatedEventos, pushSubscriptions: subscriptions });

  console.log(`[${nome}] Lembrete enviado para ${enviados.length} evento(s) de ${todayStr}.`);
}
