// Cloudflare Worker: guarda os dados das duas agendas no Cloudflare KV
// (antes era JSONBin.io, que esgotou a cota gratuita e parou de responder),
// recebe mensagens do WhatsApp via webhook do Twilio pra cadastrar eventos,
// e serve a API que agenda.html/agenda-dois.html e os scripts do GitHub
// Actions usam pra ler/salvar os eventos de cada agenda.
// Também dispara, via Cron Trigger, os lembretes de horário exato (remédio) —
// bem mais pontual que o schedule do GitHub Actions.

import { parseMensagem } from './parse.js';
import { runExatoParaAgenda } from './reminders.js';

// Chave pública VAPID — não é segredo, o navegador precisa dela pra se inscrever.
const VAPID_PUBLIC_KEY = 'BIwlkPUi5tuvTTeT9rDj1d5QJNVw6smS82AC93DFhvp6B3tzelObmzzRAkXsr2u9PTfvIP2jPrlDgtY6hFPC_qc';

const AGENDAS_VALIDAS = new Set(['calebe', 'emanuelly']);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function fetchRecord(kv, agendaId) {
  const record = await kv.get(agendaId, { type: 'json' });
  return record || {};
}

// Mescla no registro existente em vez de substituir — assim um cliente que só
// manda { eventos } (caso comum) não apaga pushSubscriptions acumuladas por
// outro caminho (essa sobrescrita foi o que apagava silenciosamente as
// inscrições de notificação no JSONBin).
async function saveRecord(kv, agendaId, partial) {
  const atual = await fetchRecord(kv, agendaId);
  const merged = { ...atual, ...partial };
  await kv.put(agendaId, JSON.stringify(merged));
  return merged;
}

async function handleGetAgenda(kv, agendaId) {
  const record = await fetchRecord(kv, agendaId);
  return new Response(JSON.stringify({ eventos: record.eventos || [], pushSubscriptions: record.pushSubscriptions || [] }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handlePutAgenda(kv, agendaId, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400, headers: CORS_HEADERS });
  }
  const partial = {};
  if (Array.isArray(body.eventos)) partial.eventos = body.eventos;
  if (Array.isArray(body.pushSubscriptions)) partial.pushSubscriptions = body.pushSubscriptions;
  const merged = await saveRecord(kv, agendaId, partial);
  return new Response(JSON.stringify({ eventos: merged.eventos || [], pushSubscriptions: merged.pushSubscriptions || [] }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handleSubscribe(kv, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400, headers: CORS_HEADERS });
  }

  if (!AGENDAS_VALIDAS.has(payload.agenda) || !payload.subscription || !payload.subscription.endpoint) {
    return new Response('Parâmetros inválidos', { status: 400, headers: CORS_HEADERS });
  }

  const record = await fetchRecord(kv, payload.agenda);
  const subs = record.pushSubscriptions || [];
  const jaExiste = subs.some(s => s.endpoint === payload.subscription.endpoint);
  if (!jaExiste) {
    subs.push(payload.subscription);
    await saveRecord(kv, payload.agenda, { pushSubscriptions: subs });
  }

  return new Response('ok', { status: 200, headers: CORS_HEADERS });
}

async function addEvento(kv, evento) {
  const record = await fetchRecord(kv, 'calebe');
  const eventos = record.eventos || [];
  eventos.push(evento);
  await saveRecord(kv, 'calebe', { eventos });
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

    if (url.pathname.startsWith('/agenda/')) {
      const agendaId = url.pathname.slice('/agenda/'.length);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (!AGENDAS_VALIDAS.has(agendaId)) {
        return new Response('Agenda desconhecida', { status: 404, headers: CORS_HEADERS });
      }
      try {
        if (request.method === 'GET') return await handleGetAgenda(env.AGENDA_KV, agendaId);
        if (request.method === 'PUT') return await handlePutAgenda(env.AGENDA_KV, agendaId, request);
      } catch (e) {
        return new Response('Erro ao acessar a agenda', { status: 500, headers: CORS_HEADERS });
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    if (url.pathname === '/subscribe') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        try {
          return await handleSubscribe(env.AGENDA_KV, request);
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
      await addEvento(env.AGENDA_KV, {
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
        nome: 'Calebe', kv: env.AGENDA_KV, agendaId: 'calebe',
        phone: env.CALLMEBOT_PHONE, apikey: env.CALLMEBOT_APIKEY,
        vapidPublicKey: VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      }),
      runExatoParaAgenda({
        nome: 'Emanuelly', kv: env.AGENDA_KV, agendaId: 'emanuelly',
        phone: env.CALLMEBOT_PHONE_EMANUELLY, apikey: env.CALLMEBOT_APIKEY_EMANUELLY,
        vapidPublicKey: VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      }),
    ]));
  },
};
