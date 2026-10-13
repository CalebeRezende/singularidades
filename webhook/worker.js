// Cloudflare Worker: recebe mensagens do WhatsApp via webhook do Twilio e
// cadastra eventos na agenda (mesmo bin do JSONBin.io usado por agenda.html).
// Também dispara, via Cron Trigger, os lembretes de horário exato (remédio) —
// bem mais pontual que o schedule do GitHub Actions.

import { parseMensagem } from './parse.js';
import { runExatoParaAgenda } from './reminders.js';

const JSONBIN_API_KEY = '$2a$10$27rhUeaoctLDffTbCTjq7OjFhxqxihlBKPnf5UKFpy1FBs7BrHXW.';
const JSONBIN_BIN_ID = '6a7379b0da38895dfebe0814';
const JSONBIN_BIN_ID_EMANUELLY = '6ac39c41ac6210605a1572d0';
const API_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// Chave pública VAPID — não é segredo, o navegador precisa dela pra se inscrever.
const VAPID_PUBLIC_KEY = 'BIwlkPUi5tuvTTeT9rDj1d5QJNVw6smS82AC93DFhvp6B3tzelObmzzRAkXsr2u9PTfvIP2jPrlDgtY6hFPC_qc';

const BINS_POR_AGENDA = {
  calebe: JSONBIN_BIN_ID,
  emanuelly: JSONBIN_BIN_ID_EMANUELLY,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function fetchRecord(binId) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
  if (!res.ok) throw new Error(`Falha ao ler JSONBin ${binId}: ${res.status}`);
  const data = await res.json();
  return data.record || {};
}

async function saveRecord(binId, record) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new Error(`Falha ao salvar JSONBin ${binId}: ${res.status}`);
}

async function handleSubscribe(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400, headers: CORS_HEADERS });
  }

  const binId = BINS_POR_AGENDA[payload.agenda];
  if (!binId || !payload.subscription || !payload.subscription.endpoint) {
    return new Response('Parâmetros inválidos', { status: 400, headers: CORS_HEADERS });
  }

  const record = await fetchRecord(binId);
  const subs = record.pushSubscriptions || [];
  const jaExiste = subs.some(s => s.endpoint === payload.subscription.endpoint);
  if (!jaExiste) {
    subs.push(payload.subscription);
    await saveRecord(binId, { ...record, pushSubscriptions: subs });
  }

  return new Response('ok', { status: 200, headers: CORS_HEADERS });
}

async function addEvento(evento) {
  const res = await fetch(`${API_BASE}/latest`, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
  const data = await res.json();
  const eventos = (data.record && data.record.eventos) ? data.record.eventos : [];
  eventos.push(evento);
  const put = await fetch(API_BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
    body: JSON.stringify({ eventos }),
  });
  if (!put.ok) throw new Error(`Falha ao salvar no JSONBin: ${put.status}`);
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function twiml(mensagem) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(mensagem)}</Message></Response>`;
  return new Response(xml, { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/vapid-public-key') {
      return new Response(VAPID_PUBLIC_KEY, { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    }

    if (url.pathname === '/subscribe') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        try {
          return await handleSubscribe(request);
        } catch (e) {
          return new Response('Erro ao salvar inscrição', { status: 500, headers: CORS_HEADERS });
        }
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Webhook da agenda Singularidades está no ar.', { status: 200 });
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return twiml('⚠️ Não consegui ler a mensagem.');
    }

    const from = (form.get('From') || '').trim();
    const body = (form.get('Body') || '').trim();

    if (env.ALLOWED_PHONE && from !== env.ALLOWED_PHONE) {
      return twiml('Este número não está autorizado a adicionar eventos nesta agenda.');
    }
    if (!body) {
      return twiml('Mensagem vazia — mande algo como "Consulta amanhã às 14h".');
    }

    const evento = parseMensagem(body);
    if (evento.erro) {
      return twiml('⚠️ Não consegui identificar a data. Tente algo como:\n"Consulta amanhã às 14h"\n"Reunião dia 10/08 9h"\n"Aula sexta das 18 às 19h30"');
    }

    try {
      await addEvento({
        id: Date.now(),
        titulo: evento.titulo,
        data: evento.data,
        hora: evento.hora,
        obs: evento.obs,
        lembreteAntesEnviado: false,
        lembreteHojeEnviado: false,
      });
    } catch (e) {
      return twiml('⚠️ Deu erro ao salvar o evento. Tenta de novo em instantes.');
    }

    const [y, m, d] = evento.data.split('-');
    const resumo = `✅ Evento salvo: ${evento.titulo}\n📅 ${d}/${m}${evento.hora ? ' às ' + evento.hora : ''}${evento.obs ? ' (' + evento.obs + ')' : ''}`;
    return twiml(resumo);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      runExatoParaAgenda({
        nome: 'Calebe', binId: JSONBIN_BIN_ID, apiKey: JSONBIN_API_KEY,
        phone: env.CALLMEBOT_PHONE, apikey: env.CALLMEBOT_APIKEY,
        vapidPublicKey: VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      }),
      runExatoParaAgenda({
        nome: 'Emanuelly', binId: JSONBIN_BIN_ID_EMANUELLY, apiKey: JSONBIN_API_KEY,
        phone: env.CALLMEBOT_PHONE_EMANUELLY, apikey: env.CALLMEBOT_APIKEY_EMANUELLY,
        vapidPublicKey: VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      }),
    ]));
  },
};
