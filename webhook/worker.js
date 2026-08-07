// Cloudflare Worker: recebe mensagens do WhatsApp via webhook do Twilio e
// cadastra eventos na agenda (mesmo bin do JSONBin.io usado por agenda.html).

import { parseMensagem } from './parse.js';

const JSONBIN_BIN_ID = '6a7379b0da38895dfebe0814';
const JSONBIN_API_KEY = '$2a$10$27rhUeaoctLDffTbCTjq7OjFhxqxihlBKPnf5UKFpy1FBs7BrHXW.';
const API_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

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
};
